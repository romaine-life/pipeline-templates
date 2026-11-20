import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zipSync} from 'fflate';
import {run} from '../lib.mjs';
import {buildFingerprint,download,findPrior,suiteInputs} from '../release/prior-build.mjs';

test('a build fingerprint follows what the binary is built from and the version it stamps, not tests or docs',()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'prior-build-'));
  try {
    process.chdir(dir);run('git',['init','-q','-b','main']);
    const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
    fs.mkdirSync('src');fs.writeFileSync('src/main.rs','fn main() {}\n');fs.writeFileSync('Cargo.toml','[package]\nname = "x"\n');fs.writeFileSync('app.ico','icon');commit();
    const cfg={topics:['release-rust'],release:{toolchains:['rust']}},plan={matrix:{include:[{id:'rust-x86_64-pc-windows-msvc'}]}},suite={job:{},files:[{path:'suites/lib.mjs',oid:'a'}]};
    const fp=(over={})=>buildFingerprint({cfg,version:'v0.1.4',suite,plan,repository:'owner/repo',...over});
    const original=fp();
    assert.equal(fp(),original);
    assert.notEqual(fp({version:'v0.1.5'}),original);
    assert.notEqual(fp({suite:{...suite,files:[{path:'suites/lib.mjs',oid:'b'}]}}),original);
    assert.notEqual(fp({cfg:{...cfg,topics:[...cfg.topics,'rust-build-linux-amd64']}}),original);
    assert.notEqual(fp({plan:{matrix:{include:[...plan.matrix.include,{id:'rust-x86_64-unknown-linux-gnu'}]}}}),original);
    fs.mkdirSync('tests');fs.writeFileSync('tests/it.rs','#[test] fn t() {}\n');fs.writeFileSync('README.md','docs');commit();
    assert.equal(fp(),original);
    fs.writeFileSync('app.ico','another icon');commit();
    assert.notEqual(fp(),original);
    assert.throws(()=>fp({version:''}),/version/);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a release build depends on the pipeline-templates files it runs, not the rest of the repository',()=>{
  const files={
    'suites/release/ci.yml':'jobs:\n  check-build:\n    steps:\n    - uses: ./_ci/actions/rust-toolchain\n    - run: node _ci/suites/release/build.mjs\n',
    'suites/release/build.mjs':"import {run} from '../lib.mjs';\nrun('x',[path.join(suites,kind,'build.mjs')]);\n",
    'suites/rust/build.mjs':"import {tool} from '../tools.mjs';\nconst data='rust/targets.json';\n",
    'suites/rust/targets.json':'{}','suites/lib.mjs':"export const docs='README.md';const fleet='fleet.json';\n",'suites/tools.mjs':'',
    'suites/go/build.mjs':'go','suites/tofu/plan.mjs':'tofu','suites/package-lock.json':'{}','README.md':'docs','fleet.json':'{}',
    'actions/rust-toolchain/action.yml':'rust','actions/rust-toolchain/tests/t.js':'test','actions/setup-go/action.yml':'go','actions/pins.txt':'pins',
  };
  const inputs=()=>suiteInputs(['rust'],{entries:Object.keys(files).map(file=>({path:file,oid:file})),read:oid=>files[oid]});
  assert.deepEqual(inputs().files.map(file=>file.path),['actions/pins.txt','actions/rust-toolchain/action.yml','suites/lib.mjs','suites/package-lock.json','suites/release/build.mjs','suites/rust/build.mjs','suites/rust/targets.json','suites/tools.mjs']);
  assert.deepEqual(inputs().job.steps[0],{uses:'./_ci/actions/rust-toolchain'});
});

// A Forgejo that merged PR 25, whose head 'h2' had release runs 10 (older) and 11.
function forgejo({jobs={},artifacts={},logs={},pull={number:25,merged:true}}={}) {
  const url='https://forgejo.test/api/v1/repos/o/r',calls=[];
  const get=async(address,{allow404,text}={})=>{
    calls.push(address);const route=address.slice(url.length);
    if(route.startsWith('/commits/'))return pull;
    if(route.startsWith('/pulls/25/commits'))return [{sha:'h1'},{sha:'h2'}];
    if(route.startsWith('/actions/runs?')) {
      const query=new URL(address).searchParams,head=query.get('head_sha');
      // As Forgejo does, the event filter drops the runs a push to the PR started: here, all of them.
      if(query.has('event'))return {workflow_runs:[]};
      return {workflow_runs:head==='h2'?[{id:10,event:'pull_request',workflow_id:'release/ci.yml',commit_sha:'h2'},{id:11,event:'pull_request',workflow_id:'release/ci.yml',commit_sha:'h2'},{id:12,event:'pull_request',workflow_id:'rust/ci.yml',commit_sha:'h2'},{id:13,event:'push',workflow_id:'release/ci.yml',commit_sha:'h2'}]:[]};
    }
    let m=route.match(/^\/actions\/runs\/(\d+)\/jobs$/);if(m)return jobs[m[1]] || [];
    m=route.match(/^\/actions\/runs\/(\d+)\/artifacts$/);if(m)return artifacts[m[1]] || [];
    m=route.match(/^\/actions\/jobs\/(\d+)\/logs/);if(m){assert.ok(text);return logs[m[1]] || '';}
    throw new Error(`unexpected ${address}`);
  };
  return {url,get,calls};
}
const parts=['rust-x86_64-pc-windows-msvc'],now=Date.parse('2026-11-20T12:00:00Z'),later='2026-11-27T12:00:00Z';
const builds=(run,status='success')=>[{id:run*100,name:'scope',attempt:1,status:'success'},{id:run*100+1,name:'check-build (rust, x86_64-pc-windows-msvc) (...)',status}];
const kept=run=>[{id:run*1000,name:'check-release-rust-x86_64-pc-windows-msvc',expired:false,expires_at:later}];
const proof=(head,fingerprint)=>JSON.stringify({content:'CI_BUILD_V1 '+JSON.stringify({head,fingerprint})})+'\n';
const quiet=()=>{};

test('a merge takes the newest PR run that attested its fingerprint and still holds every part',async()=>{
  const f=forgejo({jobs:{10:builds(10),11:builds(11)},artifacts:{10:kept(10),11:kept(11)},logs:{1000:proof('h2','f'),1100:proof('h2','other')}});
  const prior=await findPrior({sha:'m',fingerprint:'f',parts,get:f.get,url:f.url,now,probe:async()=>true,log:quiet});
  assert.equal(prior.run,10);
  assert.equal(prior.artifacts[0].id,10000);
});

test('a merge builds when no run matches: another version or inputs, a failed part, expiring files, or no PR',async()=>{
  const find=(f,over={})=>findPrior({sha:'m',fingerprint:'f',parts,get:f.get,url:f.url,now,probe:async()=>true,log:quiet,...over});
  assert.equal(await find(forgejo({jobs:{11:builds(11)},artifacts:{11:kept(11)},logs:{1100:proof('h2','other')}})),null);
  assert.equal(await find(forgejo({jobs:{11:builds(11)},artifacts:{11:kept(11)},logs:{1100:proof('h1','f')}})),null);
  assert.equal(await find(forgejo({jobs:{11:builds(11,'failure')},artifacts:{11:kept(11)},logs:{1100:proof('h2','f')}})),null);
  assert.equal(await find(forgejo({jobs:{11:builds(11)},artifacts:{11:[{...kept(11)[0],expires_at:'2026-11-20T12:30:00Z'}]},logs:{1100:proof('h2','f')}})),null);
  assert.equal(await find(forgejo({jobs:{11:builds(11)},artifacts:{11:kept(11)},logs:{1100:proof('h2','f')}}),{parts:[...parts,'rust-x86_64-unknown-linux-gnu']}),null);
  assert.equal(await find(forgejo({pull:null})),null);
  assert.equal(await find(forgejo({pull:{number:25,merged:false}})),null);
});

test('a merge refuses a build its token can\'t download, so the release builds instead',async()=>{
  const f=forgejo({jobs:{11:builds(11)},artifacts:{11:kept(11)},logs:{1100:proof('h2','f')}});
  await assert.rejects(findPrior({sha:'m',fingerprint:'f',parts,get:f.get,url:f.url,now,probe:async()=>false,log:quiet}),/can't be downloaded/);
});

test('the prior build\'s files land where assemble reads a build\'s artifacts, and a path escaping its folder fails',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'prior-download-'));
  const original=globalThis.fetch,zips={};
  globalThis.fetch=async address=>{const bytes=zips[address];return {ok:Boolean(bytes),status:bytes?200:404,arrayBuffer:async()=>bytes.buffer};};
  try {
    process.chdir(dir);
    const f=forgejo({artifacts:{11:kept(11)}});
    zips[`${f.url}/actions/artifacts/11000/zip`]=zipSync({'rio-windows-amd64.exe':new TextEncoder().encode('exe'),'conpty.dll':new TextEncoder().encode('dll')});
    await download(11,parts,{get:f.get,url:f.url});
    assert.deepEqual(fs.readdirSync('parts/release-rust-x86_64-pc-windows-msvc').sort(),['conpty.dll','rio-windows-amd64.exe']);
    assert.equal(fs.readFileSync('parts/release-rust-x86_64-pc-windows-msvc/rio-windows-amd64.exe','utf8'),'exe');
    zips[`${f.url}/actions/artifacts/11000/zip`]=zipSync({'../escape.exe':new TextEncoder().encode('x')});
    await assert.rejects(download(11,parts,{get:f.get,url:f.url,directory:'again'}),/repository-relative/);
    await assert.rejects(download(11,['rust-aarch64-pc-windows-msvc'],{get:f.get,url:f.url,directory:'missing'}),/no longer holds/);
  } finally {globalThis.fetch=original;process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});
