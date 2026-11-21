// A release-external part's PR build published by its merge instead of dispatching build.yml
// again (PIPT-55), as prior-build.test.mjs does for the suite's own build parts (PIPT-53).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../lib.mjs';
import {externalFingerprint,findAll,findPriorExternal,workflowSuiteInputs} from '../release/prior-build.mjs';
import {keepForMerge} from '../release/complete-external.mjs';

function repository(fn) {
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'prior-external-'));
  const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
  return (async()=>{
    try {process.chdir(dir);run('git',['init','-q','-b','main']);await fn(commit);}
    finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
  })();
}
const cfg={topics:['release-external'],release:{external:[{id:'build',workflow:'build.yml'}]}},part=cfg.release.external[0];
const workflowText='jobs: {build: {steps: [{uses: ./_ci/actions/release-version}, {run: node _ci/suites/release/complete-external.mjs}]}}\n';

test('an external part depends on the pipeline-templates files its workflow runs, from its actions and scripts',()=>{
  const files={
    'suites/release/complete-external.mjs':"import {stagePart} from './protocol.mjs';\n",'suites/release/protocol.mjs':"import {api} from '../lib.mjs';\n",'suites/lib.mjs':'',
    'suites/inputs.mjs':"import {x} from './input-patterns.mjs';\n",'suites/input-patterns.mjs':'','suites/release/build.mjs':'unused',
    'actions/suite/action.yml':'suite','actions/release-version/version.js':'v','actions/release-version/tests/t.js':'test','actions/setup-go/action.yml':'go','actions/pins.txt':'pins',
  };
  const workflow=[
    'jobs:','  scope:','    steps:','      - uses: actions/checkout@v4','      - uses: ./_ci/actions/suite','      - run: node _ci/suites/inputs.mjs release',
    '  build:','    steps:','      - uses: ./_ci/actions/release-version','      - run: |','          echo building','          node ./_ci/suites/release/complete-external.mjs',''].join('\n');
  const inputs=workflowSuiteInputs(workflow,{entries:Object.keys(files).map(file=>({path:file,oid:file})),read:oid=>files[oid]});
  assert.deepEqual(inputs.files.map(file=>file.path),['actions/pins.txt','actions/release-version/version.js','actions/suite/action.yml','suites/input-patterns.mjs','suites/inputs.mjs','suites/lib.mjs','suites/release/complete-external.mjs','suites/release/protocol.mjs']);
});

test("an external part's fingerprint follows its workflow, what the release reads and the tag it stamps",()=>repository(commit=>{
  fs.mkdirSync('.forgejo/workflows',{recursive:true});fs.writeFileSync('.forgejo/workflows/build.yml',workflowText);
  fs.mkdirSync('model');fs.writeFileSync('model/export.py','export');commit();
  const suite={files:[{path:'suites/release/complete-external.mjs',oid:'a'}]};
  const fp=(over={})=>externalFingerprint({cfg,part,version:'v0.1.4',suite,repository:'owner/repo',...over});
  const original=fp();
  assert.equal(fp(),original);
  assert.notEqual(fp({version:'v0.1.5'}),original);
  assert.notEqual(fp({suite:{files:[{path:'suites/release/complete-external.mjs',oid:'b'}]}}),original);
  assert.notEqual(fp({part:{id:'other',workflow:'build.yml'}}),original);
  assert.notEqual(fp({cfg:{...cfg,topics:[...cfg.topics,'home-sync'],release:{...cfg.release,homeSync:true}}}),original);
  fs.mkdirSync('tests');fs.writeFileSync('tests/model.rs','#[test] fn t() {}\n');fs.writeFileSync('README.md','docs');fs.writeFileSync('.forgejo/workflows/other.yml','jobs: {}\n');commit();
  assert.equal(fp(),original,'tests, documents and other workflows are not what the part ships');
  fs.writeFileSync('.forgejo/workflows/build.yml','jobs: {build: {steps: [{run: echo changed}]}}\n');commit();
  const changed=fp();
  assert.notEqual(changed,original,'the workflow that builds the part counts');
  fs.writeFileSync('model/export.py','export again');commit();
  assert.notEqual(fp(),changed);
  // Given no suite, it reads the workflow and this pipeline-templates checkout's files.
  assert.match(externalFingerprint({cfg,part,version:'v0.1.4',repository:'owner/repo'}),/^[0-9a-f]{64}$/);
  fs.rmSync('.forgejo',{recursive:true});commit();
  assert.throws(()=>externalFingerprint({cfg,part,version:'v0.1.4'}),/no \.forgejo\/workflows\/build\.yml/);
}));

test("a pull request's external build packages its files as the release would and attests them with the tag it stamped",()=>repository(commit=>{
  fs.mkdirSync('.forgejo/workflows',{recursive:true});fs.writeFileSync('.forgejo/workflows/build.yml',workflowText);commit();
  fs.mkdirSync('dist/model',{recursive:true});fs.writeFileSync('dist/model/beat.onnx','model');fs.writeFileSync('dist/at-terminal.cer','cert');
  const old={...process.env},lines=[],log=console.log;
  process.env.VERSION='v0.1.4';process.env.GITHUB_OUTPUT=path.resolve('outputs');process.env.GITHUB_REPOSITORY='owner/repo';delete process.env.PART_ID;
  console.log=line=>lines.push(line);
  try {keepForMerge({cfg,plan:{external:[part]}});}
  finally {console.log=log;Object.assign(process.env,old);for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];}
  const platform=process.platform==='win32'?'model-windows.zip':'model-linux.tar.gz';
  assert.deepEqual(fs.readdirSync('dist').sort(),['at-terminal.cer',platform].sort());
  assert.equal(fs.readFileSync('outputs','utf8'),'artifact=check-release-build\n');
  const proof=JSON.parse(lines.find(line=>line.startsWith('CI_BUILD_V1 ')).slice('CI_BUILD_V1 '.length));
  assert.equal(proof.head,run('git',['rev-parse','HEAD'],{stdio:['ignore','pipe','inherit'],encoding:'utf8'}));
  process.env.GITHUB_REPOSITORY='owner/repo';
  try {assert.equal(proof.fingerprint,externalFingerprint({cfg,part,version:'v0.1.4'}));}
  finally {if('GITHUB_REPOSITORY' in old)process.env.GITHUB_REPOSITORY=old.GITHUB_REPOSITORY;else delete process.env.GITHUB_REPOSITORY;}
  assert.throws(()=>keepForMerge({cfg,plan:{external:[]}}),/external build/);
}));

// The merged PR 25's build.yml runs at its head 'h2': 20 (older) and 21, beside the release suite's 22.
function forgejo({jobs={},artifacts={},logs={}}={}) {
  const url='https://forgejo.test/api/v1/repos/o/r';
  const get=async(address,{text}={})=>{
    const route=address.slice(url.length);
    if(route.startsWith('/commits/'))return {number:25,merged:true};
    if(route.startsWith('/pulls/25/commits'))return [{sha:'h1'},{sha:'h2'}];
    if(route.startsWith('/actions/runs?')) {
      const head=new URL(address).searchParams.get('head_sha');
      return {workflow_runs:head==='h2'?[{id:20,event:'pull_request',workflow_id:'build.yml',commit_sha:'h2'},{id:21,event:'pull_request',workflow_id:'build.yml',commit_sha:'h2'},{id:22,event:'pull_request',workflow_id:'release/ci.yml',commit_sha:'h2'},{id:23,event:'workflow_dispatch',workflow_id:'build.yml',commit_sha:'h2'}]:[]};
    }
    let m=route.match(/^\/actions\/runs\/(\d+)\/jobs$/);if(m)return jobs[m[1]] || [];
    m=route.match(/^\/actions\/runs\/(\d+)\/artifacts$/);if(m)return artifacts[m[1]] || [];
    m=route.match(/^\/actions\/jobs\/(\d+)\/logs/);if(m){assert.ok(text);return logs[m[1]] || '';}
    throw new Error(`unexpected ${address}`);
  };
  return {url,get};
}
const now=Date.parse('2026-11-20T12:00:00Z'),later='2026-11-27T12:00:00Z',quiet=()=>{};
const jobs=(run,status='success')=>[{id:run*100,name:'scope',attempt:1,status:'success'},{id:run*100+1,name:'build',attempt:1,status}];
const kept=run=>[{id:run*1000,name:'check-release-build',expired:false,expires_at:later}];
const proof=(head,fingerprint)=>JSON.stringify({content:'CI_BUILD_V1 '+JSON.stringify({head,fingerprint})})+'\n';
const find=(f,over={})=>findPriorExternal({sha:'m',fingerprint:'f',part,get:f.get,url:f.url,now,probe:async()=>true,log:quiet,...over});

test("a merge publishes the newest PR build.yml run that attested the part's fingerprint and keeps its files",async()=>{
  const prior=await find(forgejo({jobs:{20:jobs(20),21:jobs(21),22:jobs(22)},artifacts:{20:kept(20),21:kept(21),22:kept(22)},logs:{2001:proof('h2','f'),2101:proof('h2','other'),2201:proof('h2','f')}}));
  assert.equal(prior.run,20);
  assert.equal(prior.artifact.id,20000);
});

test("a merge dispatches the part when no PR run matches: other inputs, a failed job, files gone, or a token that can't read them",async()=>{
  assert.equal(await find(forgejo({jobs:{21:jobs(21)},artifacts:{21:kept(21)},logs:{2101:proof('h2','other')}})),null);
  assert.equal(await find(forgejo({jobs:{21:jobs(21)},artifacts:{21:kept(21)},logs:{2101:proof('h1','f')}})),null);
  assert.equal(await find(forgejo({jobs:{21:jobs(21,'failure')},artifacts:{21:kept(21)},logs:{2101:proof('h2','f')}})),null);
  assert.equal(await find(forgejo({jobs:{21:jobs(21)},artifacts:{},logs:{2101:proof('h2','f')}})),null);
  assert.equal(await find(forgejo({jobs:{21:jobs(21)},artifacts:{21:[{...kept(21)[0],expires_at:'2026-11-20T12:30:00Z'}]},logs:{2101:proof('h2','f')}})),null);
  // The release suite's own PR run is not the part's build, whatever it holds.
  assert.equal(await find(forgejo({jobs:{22:jobs(22)},artifacts:{22:kept(22)},logs:{2201:proof('h2','f')}})),null);
  await assert.rejects(find(forgejo({jobs:{21:jobs(21)},artifacts:{21:kept(21)},logs:{2101:proof('h2','f')}}),{probe:async()=>false}),/can't be downloaded/);
});

test('a merge looks up the local and the external parts apart, and a failed lookup builds only that part',()=>repository(async commit=>{
  fs.mkdirSync('.forgejo/workflows',{recursive:true});fs.writeFileSync('.forgejo/workflows/build.yml',workflowText);commit();
  const both={topics:['release-external','release-rust'],release:{toolchains:['rust'],external:[part]}};
  const plan={local:true,matrix:{include:[{id:'rust-x86_64-unknown-linux-gnu',toolchain:'rust'}]},external:[part]};
  const logs=[],asked=[];
  const result=await findAll({cfg:both,plan,version:'v0.1.4',log:line=>logs.push(line),
    find:async({parts})=>{asked.push(parts);throw new Error('Forgejo is down');},
    findExternal:async({part,fingerprint})=>{asked.push(part.id);assert.match(fingerprint,/^[0-9a-f]{64}$/);return {run:21};}});
  assert.deepEqual(asked,[['rust-x86_64-unknown-linux-gnu'],'build']);
  assert.deepEqual(result,{local:'',external:JSON.stringify({build:21})});
  assert.match(logs.join('\n'),/the release builds: Forgejo is down/);
  const none=await findAll({cfg,plan:{local:false,matrix:{include:[]},external:[part]},version:'v0.1.4',log:line=>logs.push(line),findExternal:async()=>{throw new Error('timeout');}});
  assert.deepEqual(none,{local:'',external:''});
  assert.match(logs.at(-1),/dispatches build\.yml: timeout/);
}));
