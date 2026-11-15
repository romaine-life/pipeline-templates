import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../lib.mjs';
import {fingerprint,nativeJob,workflowJobName} from '../fingerprints.mjs';
import {findPass,publishReuse} from '../reuse.mjs';

test('platform fingerprint producers use fixed workflow job names',()=>{
  for(const suite of ['go','rust','cmake','dotnet','python']) {
    assert.equal(nativeJob(`${suite}.test`,'ubuntu-latest'),'check-test-linux');
    assert.equal(nativeJob(`${suite}.test`,'windows-latest'),'check-test-windows');
  }
  assert.equal(nativeJob('rust.test','services'),'check-services');
});

test('fingerprints follow code, linked/embedded inputs, configuration, patterns and suite commits',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fingerprints-'));
  try {
    process.chdir(dir);run('git',['init','-b','main']);
    fs.writeFileSync('main.go','package main\n//go:embed data.txt\nvar data string\n');fs.writeFileSync('data.txt','embedded');fs.writeFileSync('README.md','[data](data.txt)\n');
    const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);};commit();
    const sha='a'.repeat(40),cfg={version:1};
    const fp=(check='go.test',variant='ubuntu-latest',settings=cfg,suite=sha)=>fingerprint(check,variant,settings,suite);
    const original=await fp(),format=await fp('go.format'),docs=await fp('docs.validate');
    fs.appendFileSync('README.md','docs only\n');commit();assert.equal(await fp(),original);assert.notEqual(await fp('docs.validate'),docs);
    const linked=await fp('docs.validate');
    fs.writeFileSync('data.txt','changed embedding');commit();assert.notEqual(await fp('docs.validate'),linked);assert.notEqual(await fp(),original);assert.equal(await fp('go.format'),format);
    fs.mkdirSync('linked');fs.writeFileSync('linked/data.txt','linked directory');fs.appendFileSync('README.md','[directory](linked/)\n');commit();
    const directory=await fp('docs.validate');fs.unlinkSync('linked/data.txt');commit();assert.notEqual(await fp('docs.validate'),directory);
    const source=await fp();
    fs.writeFileSync('.ci.json','{"version":1}');commit();const json=await fp('powershell.files');
    fs.writeFileSync('.ci.json','{"version":1,"docs":{"required":["README.md"]}}');commit();
    assert.notEqual(await fp('powershell.files'),json);assert.equal(await fp(),source);
    assert.equal(await fp('go.test','ubuntu-latest',{...cfg,docs:{required:['other.md']}}),source);
    assert.notEqual(await fp('go.test','ubuntu-latest',{...cfg,inputs:{'go.test':['extra/**']}}),source);
    assert.notEqual(await fp('go.test','ubuntu-latest',cfg,'b'.repeat(40)),source);
    assert.notEqual(await fp('rust.test','ubuntu-latest',{rust:{features:['tls']}}),await fp('rust.test','ubuntu-latest',{rust:{features:[]}}));
    assert.notEqual(await fp('go.test','services',{service:{postgres:'one'}}),await fp('go.test','services',{service:{postgres:'two'}}));
    assert.equal(await fp('go.test','windows-latest',{service:{postgres:'one'}}),await fp('go.test','windows-latest',{service:{postgres:'two'}}));
    fs.unlinkSync('main.go');commit();assert.notEqual(await fp('go.format'),format);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

test('reuse requires trusted scope attestation, workflow provenance and native success',async()=>{
  const env={...process.env};process.env.GITHUB_SERVER_URL='https://forgejo.example';process.env.GITHUB_EVENT_NAME='pull_request';
  try {
    const entry={key:'go.test/ubuntu-latest',fingerprint:'digest',suite:'suite-sha',check:'go.test',cacheKey:'ci-pass-key',producer:{workflow:'go/ci.yml',job:'check-test (ubuntu-latest)',context:'Suite go / check-test (ubuntu-latest)'}};
    let attested='digest',workflow='go/ci.yml',creator=null,state='success';
    const get=async url=>{
      if(url.endsWith('/actions/runs/7'))return {id:7,workflow_id:workflow,event:'pull_request',commit_sha:'a'.repeat(40)};
      if(url.includes('/logs?'))return JSON.stringify({time:'2025-12-31T23:59:59Z',content:'CI_FINGERPRINT_V1 '+JSON.stringify({head:'a'.repeat(40),suite:'suite-sha',checks:{[entry.key]:attested}})});
      if(url.endsWith('/jobs'))return [{name:'scope',id:2,attempt:1},{name:entry.producer.job,html_url:'https://forgejo.example/o/r/actions/runs/3/jobs/1/attempt/2',status:'skipped'}];
      if(url.includes('/statuses/'))return [{status:state,creator,context:entry.producer.context,target_url:'/o/r/actions/runs/3/jobs/1',created_at:'2026-01-01T00:00:01Z'}];
      throw new Error(url);
    };
    const cache={get:async()=>({run:7})};
    const pass=await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'});assert.equal(pass.sha,'a'.repeat(40));
    attested='forged-digest';assert.equal(await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'}),null);attested='digest';
    workflow='forged.yml';assert.equal(await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'}),null);workflow='go/ci.yml';
    creator={id:1};assert.equal(await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'}),null);creator=null;
    state='failure';assert.equal(await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'}),null);state='success';

    const sent=[];await publishReuse({check:{...entry,pass}},{get,cache,send:async(...args)=>sent.push(args),url:'https://forgejo.example/api/v1/repos/o/r',sha:'b'.repeat(40)});
    assert.equal(sent[0][1].state,'skipped');assert.ok(sent[0][1].description.includes(pass.sha));
  } finally {process.env=env;}
});


test('a requested rerun reuses historical scope and native success after the latest attempt resets',async()=>{
  const env={...process.env};process.env.GITHUB_SERVER_URL='https://forgejo.example';
  try {
    const entry={key:'go.test/ubuntu-latest',head:'a'.repeat(40),suite:'suite-sha',fingerprint:'digest',check:'go.test',cacheKey:'key',producer:{workflow:'go/ci.yml',job:'check-test (ubuntu-latest)',context:'Suite go / check-test (ubuntu-latest)'}};
    let fingerprint='digest';
    const get=async url=>{
      if(url.includes('/statuses/'))return [{id:1,creator:null,status:'success',context:entry.producer.context,target_url:'/o/r/actions/runs/12/jobs/1',created_at:'2026-01-01T00:01:00Z'}];
      if(url.endsWith('/actions/runs/7'))return {id:7,index_in_repo:12,commit_sha:entry.head,workflow_id:'go/ci.yml',event:'pull_request'};
      if(url.endsWith('/jobs'))return [{id:1,name:'scope',attempt:2},{id:2,name:entry.producer.job,html_url:'https://forgejo.example/o/r/actions/runs/12/jobs/1/attempt/2'}];
      if(url.includes('/logs?attempt=2'))return '';
      if(url.includes('/logs?attempt=1'))return JSON.stringify({time:'2026-01-01T00:00:00Z',content:'CI_FINGERPRINT_V1 '+JSON.stringify({head:entry.head,suite:entry.suite,checks:{[entry.key]:fingerprint}})});
      throw new Error(url);
    };
    const cache={get:async()=>({run:7})};
    assert.equal((await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'})).sha,entry.head);
    fingerprint='another-version';assert.equal(await findPass(entry,{get,cache,url:'https://forgejo.example/api/v1/repos/o/r'}),null);
  } finally {process.env=env;}
});


test('merging main into a PR preserves fingerprints when main changed no check inputs',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fingerprint-merge-'));
  try {
    process.chdir(dir);run('git',['init','-b','main']);
    run('git',['config','user.name','fixture']);run('git',['config','user.email','fixture@example.invalid']);
    const commit=()=>{run('git',['add','.']);run('git',['commit','-m','fixture']);};
    fs.writeFileSync('main.go','package main\n');fs.writeFileSync('README.md','base\n');commit();
    run('git',['checkout','-b','pr']);fs.writeFileSync('main.go','package main\nfunc main() {}\n');commit();
    const before=await fingerprint('go.test','ubuntu-latest',{},'a'.repeat(40));
    run('git',['checkout','main']);fs.writeFileSync('README.md','main documentation\n');commit();
    run('git',['checkout','pr']);run('git',['merge','--no-edit','main']);
    assert.equal(await fingerprint('go.test','ubuntu-latest',{},'a'.repeat(40)),before);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});
