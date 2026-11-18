import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reserve,stagePart,finalize,materializeAsset} from '../release/protocol.mjs';
import {deployJoined} from '../release/deploy.mjs';
import {releasePlan} from '../release/plan.mjs';
import {completeExternal} from '../release/complete-external.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';

test('joined release places Go and npm on Linux and only MSVC Rust on Windows',()=>{
  const result=releasePlan({release:{toolchains:['go','rust','npm'],rustTargets:[{target:'x86_64-unknown-linux-gnu'},{target:'x86_64-pc-windows-msvc'}]}},[{id:'app',buildmode:'',targets:[{goos:'linux',goarch:'amd64'}]}]);
  assert.deepEqual(result.matrix.include.map(p=>[p.toolchain,p.runner]),[['go','ubuntu-latest'],['rust','ubuntu-latest'],['rust','windows-latest'],['npm','ubuntu-latest']]);
  assert.throws(()=>releasePlan({release:{toolchains:['assets']}}),/declare the builders/);
});
test('durable draft joins out-of-order callbacks, validates bytes and recovers without polling',async()=>{
  const cwd=process.cwd(),oldEnv={...process.env},oldFetch=globalThis.fetch;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'joined-'));
  let rel=null,id=0,dispatches=0,callbacks=0,completionReceipt;const data=new Map(),states=[];
  try {
    process.chdir(root);fs.writeFileSync('.goreleaser.yaml','{version: 2, builds: [{id: app, main: ., targets: [linux_amd64_v1]}]}');
    Object.assign(process.env,{VERSION:'v0.1.1',SOURCE_SHA:'a'.repeat(40),GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main',GITHUB_SERVER_URL:'https://forgejo.romaine.life',GITHUB_REPOSITORY:'test/app',TOKEN:'test-token',GITHUB_DISPATCH_TOKEN:'github-token',GITHUB_OUTPUT:path.join(root,'outputs')});
    fleetEntry(({version:1,release:{toolchains:['go','rust','npm'],manifest:'bundle.json',checksumManifest:'SHA256SUMS',external:[{id:'macos',repository:'romaine-life/app',workflow:'macos.yml',assets:['macos.tar.gz']}]}}));
    globalThis.fetch=async(url,options={})=>{
      const u=String(url),method=options.method || 'GET';let result={};
      if(u.startsWith('https://api.github.com')){
        assert.equal(options.headers.Authorization,'token github-token');
        if(method==='POST'){dispatches++;return new Response(null,{status:204});}
        return Response.json({default_branch:'main'});
      }
      if(u.includes('/attachments/')){assert.equal(options.headers.Authorization,'token download-token');assert.equal(rel.draft,false,'draft bytes must never use the web route');return new Response(data.get(Number(u.split('/').at(-1))));}
      assert.equal(options.headers.Authorization,'token test-token');
      if(u.endsWith('/api/v1/repos/romaine-life/app'))return Response.json({default_branch:'main'});
      if(u.endsWith('/repos/romaine-life/app/actions/workflows/native.yml/dispatches')){dispatches++;return new Response(null,{status:204});}
      if(u.endsWith('/actions/workflows/release%2Fci.yml/dispatches')){callbacks++;const body=JSON.parse(options.body);completionReceipt=JSON.parse(body.inputs.receipt);assert.equal(body.inputs['source-sha'],'a'.repeat(40));return new Response(null,{status:204});}
      if(u.endsWith('/api/v1/repos/test/app'))return Response.json({default_branch:'main'});
      if(u.endsWith('/releases/1') && method==='PATCH'){Object.assign(rel,JSON.parse(options.body));return Response.json(rel);}
      if(u.includes('/statuses/')){states.push(JSON.parse(options.body).state);return Response.json({});}
      if(u.endsWith('/releases/tags/v0.1.1'))return rel ? Response.json(rel) : new Response('{}',{status:404});
      if(u.endsWith('/releases') && method==='POST')rel={...JSON.parse(options.body),id:1,assets:[]};
      if(u.includes('/assets?')){
        const file=options.body.get('attachment'),bytes=Buffer.from(await file.arrayBuffer()),name=new URL(u).searchParams.get('name');
        const asset={id:++id,name,size:bytes.length,uuid:`uuid-${id}`,type:'attachment',browser_download_url:`https://forgejo.romaine.life/attachments/${id}`};
        data.set(id,bytes);rel.assets.push(asset);result=asset;
      }else if(method==='DELETE')rel.assets=rel.assets.filter(a=>a.id!==Number(u.split('/').at(-1)));
      else result=rel;
      return Response.json(result);
    };
    await reserve();await reserve();assert.equal(dispatches,1);assert.equal(rel.prerelease,true);
    assert.equal(await finalize(),false);
    fs.writeFileSync('macos.tar.gz','macOS binary');
    fs.mkdirSync('dist');fs.copyFileSync('macos.tar.gz','dist/macos.tar.gz');
    Object.assign(process.env,{RELEASE_SERVER_URL:'https://forgejo.romaine.life',RELEASE_REPOSITORY:'test/app',PART_ID:'macos'});
    await completeExternal();assert.equal(callbacks,1);
    assert.equal(await finalize('macos','success',completionReceipt),false);
    fs.writeFileSync('app.exe','signed Windows binary');fs.writeFileSync('web.tar.gz','npm assets');
    await stagePart('local',['app.exe','web.tar.gz']);assert.equal(await finalize(),true);assert.equal(rel.prerelease,false);
    rel.draft=false;assert.equal(await finalize('macos','success',completionReceipt),true);rel.draft=true;
    assert.match(data.get(rel.assets.find(a=>a.name==='SHA256SUMS').id).toString(),/macos.tar.gz/);
    const binary=rel.assets.find(a=>a.name==='app.exe');binary.size++;
    await assert.rejects(finalize('macos','success',completionReceipt),/differs from its receipt/);
    await stagePart('local',['app.exe','web.tar.gz']);assert.equal(await finalize('macos','success',completionReceipt),true);
    process.env.SOURCE_SHA='b'.repeat(40);await assert.rejects(finalize('macos'),/source SHA/);process.env.SOURCE_SHA='a'.repeat(40);
    await assert.rejects(finalize('unknown'),/undeclared/);
    await assert.rejects(finalize('macos','failure'),/build failed/);assert.equal(states.at(-1),'failure');
    rel.draft=false;await assert.rejects(stagePart('macos',['macos.tar.gz']),/published/);
    await assert.rejects(materializeAsset('app.exe','downloaded.exe'),/DOWNLOAD_TOKEN/);process.env.DOWNLOAD_TOKEN='download-token';
    await materializeAsset('app.exe','downloaded.exe');assert.equal(fs.readFileSync('downloaded.exe','utf8'),'signed Windows binary');
    for(const provider of ['github','forgejo']) {
      rel=null;data.clear();id=0;
      process.env.DISPATCH_TOKEN='test-token';
      fleetEntry(({version:1,release:{toolchains:[],external:[{id:'macos',provider,repository:'romaine-life/app',workflow:provider==='github'?'macos.yml':'native.yml',assets:['macos.tar.gz']}]}}));
      await reserve();assert.equal(await finalize(),false);
      completionReceipt=await stagePart('macos',['macos.tar.gz'],{deferReceipt:true});assert.equal(await finalize('macos','success',completionReceipt),true);
      await assert.rejects(stagePart('local',['app.exe']),/undeclared/);
    }
    fleetEntry(({version:1,release:{image:'web'},web:{image:true}}));
    const calls=[];
    await deployJoined(async(...args)=>calls.push(args),(...args)=>calls.push(args));
    assert.deepEqual(calls[0],['image.txt','.ci-image-pin']);assert.ok(calls[1][1][0].replaceAll('\\','/').endsWith('cluster-service/pin.mjs'));assert.equal(calls[1][1][1],'web');
  }finally{globalThis.fetch=oldFetch;process.chdir(cwd);for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);fs.rmSync(root,{recursive:true,force:true});}
});
