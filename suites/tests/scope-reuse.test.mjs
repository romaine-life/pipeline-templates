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
import {fleetEntry, currentEntry} from './fleet-entry.mjs';
import {serviceImages} from '../conventions.mjs';

test('fixed platform selectors handle none, one and all reused, undeclared platforms and service-only Linux',()=>{
  const platforms=['ubuntu-latest','windows-latest'];
  for(const suite of ['go','rust','cmake','dotnet','python'])for(const reused of [[],['ubuntu-latest'],platforms]) {
    const matrix=testPlatforms(suite,{[suite]:{platforms}},platform=>!reused.includes(platform));
    assert.deepEqual(matrix.platforms,platforms);
    assert.deepEqual(matrix.run,Object.fromEntries(platforms.map(platform=>[platform,!reused.includes(platform)])));
  }
  const service=testPlatforms('rust',{rust:{platforms:['ubuntu-latest']},service:{postgres:'pinned'}},()=>true);
  assert.deepEqual(service,{platforms:['ubuntu-latest'],run:{'ubuntu-latest':false}});
  const external=releasePlan({release:{external:[{id:'build',workflow:'build.yml'}]}});
  assert.equal(external.local,false);assert.equal(external.matrix.include.length,1);assert.equal(external.matrix.include[0].toolchain,'external');
  assert.throws(()=>releasePlan({release:{toolchains:['rust'],rustTargets:[]}}),/nonempty/);
});

// The real scope process on a PR: a fixture repo whose base commit is BASE, then the PR's commit.
const goRepository=root=>{fs.writeFileSync(path.join(root,'main.go'),'package main\n');fs.writeFileSync(path.join(root,'notes.txt'),'base\n');};
async function prScope(change,{suite='go',settings={version:1,go:{platforms:['ubuntu-latest','windows-latest']},service:{postgres:serviceImages.postgres}},setup=goRepository}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scope-reuse-'));
  const server=http.createServer((request,response)=>{assert.match(request.url,/^\/_apis\/artifactcache\/cache\?/);response.writeHead(204).end();});
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    fleetEntry(settings,'test/scope');
    const git=args=>run('git',args,{cwd:root,stdio:['ignore','pipe','inherit'],encoding:'utf8'});
    const commit=()=>{git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
    setup(root);
    git(['init','-q','-b','main']);commit();
    const base=git(['rev-parse','HEAD']).trim();
    change(root);commit();
    let text='';
    const exit=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(suites,'inputs.mjs'),suite],{cwd:root,env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_OUTPUT:'',BASE:base,GITHUB_REPOSITORY:'test/scope',TOKEN:'fixture',ACTIONS_CACHE_URL:`http://127.0.0.1:${server.address().port}/`,ACTIONS_RUNTIME_TOKEN:'fixture'}});
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

// Two npm packages (crenellation's backend and frontend, CREN-1): each one's tests are a check of
// its own folder and what it references elsewhere, so a change runs only the tests that read it.
test("an npm package's tests run when its own folder or what it references changed, and no one else's",async()=>{
  const write=(root,file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  const setup=root=>{
    write(root,'backend/package.json',JSON.stringify({scripts:{lint:'sh -n ../bin/preview',test:'npm --prefix ../frontend run build && node --test'}}));
    write(root,'backend/server.js','export {};\n');
    write(root,'frontend/package.json',JSON.stringify({scripts:{lint:'tsc --noEmit',test:'vitest run'}}));
    write(root,'frontend/src/names.test.ts',"const here = dirname(fileURLToPath(import.meta.url));\nreadFileSync(join(here, '..', '..', 'lab', 'names.json'));\n");
    write(root,'lab/names.json','{}\n');write(root,'lab/unread.py','\n');write(root,'bin/preview','\n');
  };
  const scope=(file,text='changed\n')=>prScope(root=>write(root,file,text),{suite:'web-app',settings:{version:1,suites:['web-app']},setup});
  const packages=outputs=>outputs.test==='true'?JSON.parse(outputs['test-packages']).package:[];
  const backend=await scope('backend/server.js');
  assert.deepEqual(packages(backend),['backend']);
  assert.deepEqual(Object.keys(JSON.parse(backend.fingerprints)).sort(),['web-app.test/backend','web-app.test/frontend']);
  assert.deepEqual(packages(await scope('bin/preview')),['backend']);
  assert.deepEqual(packages(await scope('lab/names.json','{"a":1}\n')),['frontend']);
  // The backend's tests build the frontend, so a frontend change runs both.
  assert.deepEqual(packages(await scope('frontend/src/app.ts')),['backend','frontend']);
  for(const file of ['lab/unread.py','frontend/README.md','docs/notes.txt']) {
    const outputs=await scope(file);
    assert.equal(outputs.test,'false',file);assert.deepEqual(JSON.parse(outputs['test-packages']).package,['backend','frontend'],file);
  }
});
