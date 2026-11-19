import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {run,suites} from '../lib.mjs';
import {testPlatforms} from '../inputs.mjs';
import {releasePlan} from '../release/plan.mjs';
import {fleetEntry, currentEntry, servicesFile} from './fleet-entry.mjs';

test('fixed platform selectors handle none, one and all reused, undeclared platforms and service-only Linux',()=>{
  const platforms=['ubuntu-latest','windows-latest'];
  for(const suite of ['go','rust','cmake','dotnet','python'])for(const reused of [[],['ubuntu-latest'],platforms]) {
    const matrix=testPlatforms(suite,{[suite]:{platforms}},platform=>!reused.includes(platform));
    assert.deepEqual(matrix.platforms,platforms);
    assert.deepEqual(matrix.run,Object.fromEntries(platforms.map(platform=>[platform,!reused.includes(platform)])));
  }
  const service=testPlatforms('rust',{rust:{platforms:['ubuntu-latest']},service:{postgres:'pinned'}},()=>true);
  assert.deepEqual(service,{platforms:['ubuntu-latest'],run:{'ubuntu-latest':false}});
  const external=releasePlan({release:{external:[{id:'macos',repository:'o/r',workflow:'macos.yml',assets:['macos.zip']}]}});
  assert.equal(external.local,false);assert.equal(external.matrix.include.length,1);assert.equal(external.matrix.include[0].toolchain,'external');
  assert.throws(()=>releasePlan({release:{toolchains:['rust'],rustTargets:[]}}),/nonempty/);
});

// The real scope process on a PR: a fixture repo whose base commit is BASE, then the PR's commit.
async function prScope(change) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scope-reuse-'));
  const server=http.createServer((request,response)=>{assert.match(request.url,/^\/_apis\/artifactcache\/cache\?/);response.writeHead(204).end();});
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const settings={version:1,go:{platforms:['ubuntu-latest','windows-latest']},service:{postgres:`artifacts.home.romaine.life/dockerhub/library/postgres:17@sha256:${'a'.repeat(64)}`}};
    fleetEntry(settings,'test/scope');servicesFile(settings,root);
    const git=args=>run('git',args,{cwd:root,stdio:['ignore','pipe','inherit'],encoding:'utf8'});
    const commit=()=>{git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
    fs.writeFileSync(path.join(root,'main.go'),'package main\n');
    fs.writeFileSync(path.join(root,'notes.txt'),'base\n');
    git(['init','-q','-b','main']);commit();
    const base=git(['rev-parse','HEAD']).trim();
    change(root);commit();
    let text='';
    const exit=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(suites,'inputs.mjs'),'go'],{cwd:root,env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_OUTPUT:'',BASE:base,GITHUB_REPOSITORY:'test/scope',TOKEN:'fixture',ACTIONS_CACHE_URL:`http://127.0.0.1:${server.address().port}/`,ACTIONS_RUNTIME_TOKEN:'fixture'}});
      child.stdout.on('data',chunk=>text+=chunk);child.stderr.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('close',resolve);
    });
    assert.equal(exit,0,text);
    return Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
}
test('the real PR scope process plans independent native Windows and Linux-service fingerprints',async()=>{
  const outputs=await prScope(root=>fs.writeFileSync(path.join(root,'main.go'),'package main\n\nfunc main() {}\n'));
  const checks=JSON.parse(outputs.fingerprints);
  assert.deepEqual(Object.keys(checks).sort(),['go.format/ubuntu-latest','go.test/services','go.test/windows-latest']);
  assert.equal(outputs['service-test'],'true');assert.equal(outputs.test,'true');assert.deepEqual(JSON.parse(outputs.platforms),['ubuntu-latest','windows-latest']);assert.equal(outputs['test-linux'],'false');assert.equal(outputs['test-windows'],'true');
  for(const entry of Object.values(checks)){assert.match(entry.fingerprint,/^[a-f0-9]{64}$/);assert.equal(entry.suite,outputs['suite-sha']);assert.equal(entry.pass,null);}
});
test("a PR that changes only docs and manifests doesn't run the tests, and any other change does",async()=>{
  const outputs=await prScope(root=>{fs.writeFileSync(path.join(root,'README.md'),'changed\n');fs.mkdirSync(path.join(root,'k8s'));fs.writeFileSync(path.join(root,'k8s/values.yaml'),'tag: v1\n');});
  for(const name of ['format','test','service-test','test-linux','test-windows'])assert.equal(outputs[name],'false',name);
  const other=await prScope(root=>fs.writeFileSync(path.join(root,'notes.txt'),'changed\n'));
  assert.equal(other.format,'false');assert.equal(other.test,'true');assert.equal(other['test-windows'],'true');
});
