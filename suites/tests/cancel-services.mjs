import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {capture,run,suites} from '../lib.mjs';
import {ownerLabel} from '../services.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';
import {serviceImages} from '../conventions.mjs';

const runnerImage='forgejo.romaine.life/nelsong6/linux-runner:v13.2.0.0@sha256:c44ab0713fa906e309651f00be9af908998bc001dec20f270dcb30717e5cc7bc';
const jobImage='artifacts.home.romaine.life/ghcr/catthehacker/ubuntu:act-24.04@sha256:19619a010b204f44c5340bff7d39b68551109fe6a56a53f75201ea91e05d4270';
const marker=path.resolve('.ci-cancel-services.json');
function cleanup() {
  if(!fs.existsSync(marker))return;
  const state=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(!/^ci-cancel-[0-9a-f-]{36}$/.test(state.nonce))throw new Error('invalid cancellation fixture ownership');
  const {nonce,dir}=state,runner=`${nonce}-runner`,holder=`${nonce}-source`,volume=`${nonce}-files`;
  const exists=name=>capture('docker',['ps','-aq','--filter',`name=^/${name}$`]);
  if(exists(runner))run('docker',['stop','--timeout','90',runner]);
  if(!state.serviceOwner && exists(holder)) {
    const copy=spawnSync('docker',['cp',`${holder}:/fixture/.ci-services.json`,path.join(dir,'recovered-state.json')],{encoding:'utf8'});
    if(copy.status===0)state.serviceOwner=JSON.parse(fs.readFileSync(path.join(dir,'recovered-state.json'),'utf8')).id;
    else if(!/Could not find the file|No such file/.test(copy.stderr))throw new Error(`recovering service ownership: ${copy.stderr}`);
  }
  if(state.serviceOwner) {
    if(!/^ci-services-[0-9a-f-]{36}$/.test(state.serviceOwner))throw new Error('invalid recovered ownership');
    const filter=['--filter',`label=${ownerLabel}=${state.serviceOwner}`];
    for(const id of capture('docker',['ps','-aq',...filter]).split('\n').filter(Boolean))run('docker',['rm','-fv',id]);
    for(const id of capture('docker',['network','ls','-q',...filter]).split('\n').filter(Boolean))run('docker',['network','rm',id]);
  }
  for(const id of capture('docker',['ps','-aq','--filter',`label=life.romaine.ci.cancellation=${nonce}`]).split('\n').filter(Boolean))run('docker',['rm','-fv',id]);
  for(const name of [runner,holder])if(exists(name))run('docker',['rm','-fv',name]);
  if(capture('docker',['volume','ls','-q','--filter',`name=^${volume}$`]))run('docker',['volume','rm',volume]);
  fs.rmSync(dir,{recursive:true,force:true});fs.unlinkSync(marker);
}
async function proveCancellation() {
const nonce=`ci-cancel-${randomUUID()}`,volume=`${nonce}-files`,holder=`${nonce}-source`,runner=`${nonce}-runner`;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-cancel-'));
let serviceOwner,serviceVolumes=[];
fs.writeFileSync(marker,JSON.stringify({nonce,dir}));
try {
  fs.mkdirSync(path.join(dir,'suites'));
  const dockerEnv=[];
  if(process.env.DOCKER_TLS_VERIFY)dockerEnv.push('DOCKER_TLS_VERIFY='+process.env.DOCKER_TLS_VERIFY);
  if(process.env.DOCKER_CERT_PATH) {
    fs.mkdirSync(path.join(dir,'docker-certs'),{mode:0o700});
    for(const file of ['ca.pem','cert.pem','key.pem']) {
      fs.copyFileSync(path.join(process.env.DOCKER_CERT_PATH,file),path.join(dir,'docker-certs',file));
      fs.chmodSync(path.join(dir,'docker-certs',file),0o600);
    }
    dockerEnv.push('DOCKER_CERT_PATH=/fixture/docker-certs');
  }
  for(const file of ['services.mjs','docker-events.mjs','config.mjs','topics.mjs','conventions.mjs','layout.mjs','lib.mjs'])fs.copyFileSync(path.join(suites,file),path.join(dir,'suites',file));
  // layout.mjs reads Cargo.toml with @iarna/toml, which needs nothing else.
  fs.cpSync(path.join(suites,'node_modules','@iarna','toml'),path.join(dir,'suites','node_modules','@iarna','toml'),{recursive:true});
  fs.copyFileSync(fleetEntry({service:serviceImages},'test/cancel'),path.join(dir,'fleet.json'));
  fs.writeFileSync(path.join(dir,'hold.mjs'),`import fs from 'node:fs';import net from 'node:net';console.log('CI_CANCEL_READY:'+JSON.parse(fs.readFileSync('.ci-services.json')).id);net.createServer().listen(0,'127.0.0.1');`);
  fs.writeFileSync(path.join(dir,'result.mjs'),`import fs from 'node:fs';console.log('CI_CANCELLED_CONFIRMED');fs.writeFileSync('cancelled-proof','cancelled');`);
  fs.writeFileSync(path.join(dir,'ordinary.mjs'),`throw new Error('ordinary step ran after cancellation');`);
  fs.writeFileSync(path.join(dir,'fixture.yml'),`name: ${nonce}
on: push
jobs:
  cancel:
    runs-on: ubuntu-latest
    env:
      CI_FLEET: /fixture/fleet.json
      CI_TOPICS: '${process.env.CI_TOPICS}'
      CI_REPOSITORY: test/cancel
    defaults:
      run:
        working-directory: /fixture
    steps:
    - run: node suites/services.mjs start
    - run: node hold.mjs
    - if: always()
      run: node suites/services.mjs stop
    - if: cancelled()
      run: node result.mjs
    - run: node ordinary.mjs
`);
  run('docker',['volume','create',volume]);
  run('docker',['create','--name',holder,'-v',`${volume}:/fixture`,'--entrypoint','/bin/true',jobImage]);
  run('docker',['cp',`${dir}/.`,`${holder}:/fixture`]);
  const daemon=process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  const socket=daemon.startsWith('unix://') ? ['-v','/var/run/docker.sock:/var/run/docker.sock'] : [];
  run('docker',['create','--name',runner,'--network','host','--user','0','-e',`DOCKER_HOST=${daemon}`,...dockerEnv.flatMap(value=>['-e',value]),'-e','NO_COLOR=1','-v',`${volume}:/fixture`,...socket,'--entrypoint','/bin/forgejo-runner',runnerImage,'exec','-C','/tmp','-W','/fixture/fixture.yml','-i',jobImage,'--network','host','--container-opts',`-v ${volume}:/fixture --label life.romaine.ci.cancellation=${nonce}`,'--env',`DOCKER_HOST=${daemon}`,...dockerEnv.flatMap(value=>['--env',value])]);
  const child=spawn('docker',['start','--attach',runner]);let logs='',sent=false;
  const result=new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>{child.kill();reject(new Error('cancelled runner did not finish cleanup'));},240000);
    child.on('error',error=>{clearTimeout(deadline);reject(error);});
    child.on('exit',code=>{clearTimeout(deadline);resolve(code);});
    const output=chunk=>{
      process.stdout.write(chunk);logs+=chunk;
      const match=logs.match(/CI_CANCEL_READY:(ci-services-[0-9a-f-]{36})/);
      if(match && !sent) {
        serviceOwner=match[1];fs.writeFileSync(marker,JSON.stringify({nonce,dir,serviceOwner}));sent=true;
        run('docker',['cp',`${holder}:/fixture/.ci-services.json`,path.join(dir,'started-services.json')]);
        serviceVolumes=JSON.parse(fs.readFileSync(path.join(dir,'started-services.json'),'utf8')).volumes;
        run('docker',['kill','--signal','SIGINT',runner]);
      }
    };
    child.stdout.on('data',output);child.stderr.on('data',output);
  });
  const exit=await result;
  assert.ok(sent,'cancel only after all three services were healthy');
  assert.notEqual(exit,0,'the nested runner job must actually be cancelled');
  assert.match(logs,/CI_CANCELLED_CONFIRMED/);
  run('docker',['cp',`${holder}:/fixture/cancelled-proof`,path.join(dir,'cancelled-proof')]);
  assert.equal(fs.readFileSync(path.join(dir,'cancelled-proof'),'utf8'),'cancelled');
  const filter=['--filter',`label=${ownerLabel}=${serviceOwner}`];
  assert.equal(capture('docker',['ps','-aq',...filter]),'');
  assert.equal(capture('docker',['network','ls','-q',...filter]),'');
  for(const name of serviceVolumes)assert.equal(capture('docker',['volume','ls','-q','--filter',`name=^${name}$`]),'');
  assert.equal(capture('docker',['ps','-aq','--filter',`label=life.romaine.ci.cancellation=${nonce}`]),'');
  console.log(`Cancelled job removed all service containers, volumes and networks: ${serviceOwner}`);
 } finally {cleanup();}
}
if(process.argv[2]==='cleanup')cleanup();
else await proveCancellation();
