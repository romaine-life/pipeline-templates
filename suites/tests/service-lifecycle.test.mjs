import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {startServices,stopServices,stateFile,ownerLabel,watchHealth} from '../services.mjs';

test('service ownership survives partial startup and cleanup failure without publishing ports',async()=>{
  const cwd=process.cwd(),oldEnv={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'services-'));
  try {
    process.chdir(dir);delete process.env.CI_SERVICE_STATE;delete process.env.GITHUB_ENV;
    const containers=new Map(),networks=new Set(),calls=[];let state,failStart=false,failRemove=false,onEvent,subscribed=false,probes=0;
    const subscribe=async(filters,observe)=>{
      assert.deepEqual(filters.event,['health_status','die']);
      assert.match(filters.label[0],new RegExp('^'+ownerLabel+'=ci-services-'));
      onEvent=observe;subscribed=true;
      return {close(){subscribed=false;}};
    };
    const read=(cmd,args)=>{
      state=JSON.parse(fs.readFileSync(stateFile(),'utf8'));
      if(args[0]==='inspect')return JSON.stringify([{State:{Running:true},NetworkSettings:{Networks:{[state.id]:{IPAddress:'172.18.0.2'}}}}]);
      assert.ok(args.includes(`label=${ownerLabel}=${state.id}`));
      return args[0]==='ps' ? [...containers.keys()].join('\n') : [...networks].join('\n');
    };
    const execute=(cmd,args)=>{
      calls.push(args);state=JSON.parse(fs.readFileSync(stateFile(),'utf8'));
      if(args[0]==='network' && args[1]==='create'){assert.ok(subscribed);networks.add(state.id);}
      if(args[0]==='run') {
        assert.ok(subscribed);assert.ok(args.includes('--health-cmd'));assert.match(args[args.indexOf('--health-cmd')+1],/pg_isready/);
        const name=args[args.indexOf('--name')+1];containers.set(name,true);
        if(failStart)throw new Error('interrupted after creation');
        onEvent({Action:'health_status: healthy',Actor:{Attributes:{name}}});
      }
      if(args[0]==='rm') {if(failRemove){failRemove=false;throw new Error('removal failed');}containers.delete(args.at(-1));}
      if(args[0]==='network' && args[1]==='rm')networks.delete(args.at(-1));
    };
    const services={postgres:`example/image@sha256:${'a'.repeat(64)}`};
    const deps={read,execute,subscribe,probe:async()=>{probes++;}};
    const env=await startServices(services,deps);assert.equal(env.DATABASE_URL,'postgres://postgres@172.18.0.2:5432/postgres');
    assert.equal(probes,1);assert.equal(subscribed,false);
    assert.equal(calls.some(args=>args.includes('-p') || args.includes('--publish')),false);
    await assert.rejects(startServices(services,deps),/already exists/);
    failRemove=true;assert.throws(()=>stopServices(deps),/cleanup failed/);assert.ok(fs.existsSync(stateFile()));
    stopServices(deps);stopServices(deps);assert.equal(containers.size+networks.size,0);
    const first=state.id;failStart=true;
    await assert.rejects(startServices(services,deps),/interrupted/);assert.notEqual(state.id,first);
    stopServices(deps);assert.equal(containers.size+networks.size,0);
    fs.writeFileSync(stateFile(),JSON.stringify({id:'unowned'}));assert.throws(()=>stopServices(deps),/ownership/);
  } finally {process.chdir(cwd);process.env=oldEnv;fs.rmSync(dir,{recursive:true,force:true});}
});

test('health events handle early/out-of-order health, exit, stream failure and one deadline',async()=>{
  for(const outcome of ['healthy','die','unhealthy','stream','deadline']) {
    let event,error,expire,closed=0,schedules=0,cancels=0;
    const id='ci-services-11111111-1111-1111-1111-111111111111';
    const monitor=await watchHealth(id,['postgres','greenmail'],{
      subscribe:async(filters,onEvent,onError)=>{event=onEvent;error=onError;return {close(){closed++;}};},
      schedule:fn=>{schedules++;expire=fn;return 123;},cancel:()=>cancels++
    });
    event({Action:'health_status: healthy',Actor:{Attributes:{name:'someone-else-postgres'}}});
    event({Action:'health_status: healthy',Actor:{Attributes:{name:`${id}-greenmail`}}});
    if(outcome==='healthy') {
      event({Action:'health_status: healthy',Actor:{Attributes:{name:`${id}-postgres`}}});
      await monitor.ready;
    } else {
      if(outcome==='die')event({Action:'die',Actor:{Attributes:{name:`${id}-postgres`}}});
      if(outcome==='unhealthy')event({Action:'health_status: unhealthy',Actor:{Attributes:{name:`${id}-postgres`}}});
      if(outcome==='stream')error(new Error('stream disconnected'));
      if(outcome==='deadline')expire();
      await assert.rejects(monitor.ready,/exited|unhealthy|stream disconnected|deadline exceeded/);
    }
    monitor.close();assert.equal(closed,1);assert.equal(schedules,1);assert.equal(cancels,1);
  }
});
