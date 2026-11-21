import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zipSync} from 'fflate';
import {run} from '../lib.mjs';
import {download,findPriorImage,imageFingerprint,imageSuiteInputs,reusable,stampsCommit} from '../cluster-service/prior-image.mjs';

test('an image fingerprint follows its Dockerfile, what it copies, the version it stamps and the suite files that build it',()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'prior-image-'));
  try {
    process.chdir(dir);run('git',['init','-q','-b','main']);
    const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
    fs.writeFileSync('Dockerfile','FROM scratch\nARG APP_VERSION\nCOPY backend/ backend/\n');fs.mkdirSync('backend');fs.writeFileSync('backend/server.js','');fs.mkdirSync('frontend');fs.writeFileSync('frontend/app.ts','');commit();
    const section={image:'romainecr.azurecr.io/app'},suite=[{path:'suites/cluster-service/image.mjs',oid:'a'}];
    const fp=(over={})=>imageFingerprint({section,version:'v0.1.4',suite,repository:'owner/app',...over});
    const original=fp();
    assert.equal(fp(),original);
    assert.notEqual(fp({version:'v0.1.5'}),original);
    assert.notEqual(fp({suite:[{path:'suites/cluster-service/image.mjs',oid:'b'}]}),original);
    assert.notEqual(fp({section:{...section,context:'k8s/image'}}),original);
    fs.writeFileSync('frontend/app.ts','changed');fs.writeFileSync('README.md','docs');commit();
    assert.equal(fp(),original,'a file the image does not copy');
    fs.writeFileSync('backend/server.js','changed');commit();
    assert.notEqual(fp(),original);
    assert.throws(()=>fp({version:''}),/version/);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

test("an image is kept for its merge only when it's built here at a version and doesn't stamp its commit",()=>{
  const read=text=>file=>file==='Dockerfile' || file==='k8s/image/Dockerfile' ? text : null;
  assert.equal(reusable({image:'x'},'v0.1.4',read('FROM scratch\nARG APP_VERSION\n')),true);
  assert.equal(reusable({image:'x',context:'k8s/image'},'v0.1.4',read('FROM scratch\n')),true);
  assert.equal(reusable({image:'x'},'',read('FROM scratch\n')),false);
  assert.equal(reusable({image:'x',build:false},'v0.1.4',read('FROM scratch\n')),false);
  // landing-page and tuimail stamp their commit, which only the merge knows.
  assert.equal(reusable({image:'x'},'v0.1.4',read('FROM scratch\nARG APP_VERSION=dev\nARG SOURCE_SHA=unknown\n')),false);
  assert.equal(stampsCommit('FROM scratch\n# ARG SOURCE_SHA is not used\n'),false);
});

test("the image's build is its image.mjs and what that reaches, not the files that carry the image",()=>{
  const files={
    'suites/cluster-service/image.mjs':"import {run} from '../lib.mjs';\nconst prior=await import('./prior-image.mjs');\nconst {registryLogin}=await import('./registry.mjs');\n",
    'suites/cluster-service/prior-image.mjs':"import x from '../fingerprints.mjs';\n",'suites/cluster-service/registry.mjs':'','suites/lib.mjs':'','suites/fingerprints.mjs':'',
    'suites/package-lock.json':'{}','actions/pins.txt':'pins',
  };
  const inputs=imageSuiteInputs({entries:Object.keys(files).map(file=>({path:file,oid:file})),read:oid=>files[oid]});
  assert.deepEqual(inputs.map(file=>file.path),['actions/pins.txt','suites/cluster-service/image.mjs','suites/lib.mjs','suites/package-lock.json']);
});

// A Forgejo that merged PR 25, whose head 'h2' had web-app runs 10 (older) and 11.
function forgejo({jobs={},artifacts={},logs={},pull={number:25,merged:true}}={}) {
  const url='https://forgejo.test/api/v1/repos/o/r';
  const get=async(address,{text}={})=>{
    const route=address.slice(url.length);
    if(route.startsWith('/commits/'))return pull;
    if(route.startsWith('/pulls/25/commits'))return [{sha:'h1'},{sha:'h2'}];
    if(route.startsWith('/actions/runs?')) {
      const head=new URL(address).searchParams.get('head_sha');
      return {workflow_runs:head==='h2'?[{id:10,event:'pull_request',workflow_id:'web-app/ci.yml',commit_sha:'h2'},{id:11,event:'pull_request',workflow_id:'web-app/ci.yml',commit_sha:'h2'},{id:12,event:'pull_request',workflow_id:'release/ci.yml',commit_sha:'h2'},{id:13,event:'push',workflow_id:'web-app/ci.yml',commit_sha:'h2'}]:[]};
    }
    let m=route.match(/^\/actions\/runs\/(\d+)\/jobs$/);if(m)return jobs[m[1]] || [];
    m=route.match(/^\/actions\/runs\/(\d+)\/artifacts$/);if(m)return artifacts[m[1]] || [];
    m=route.match(/^\/actions\/jobs\/(\d+)\/logs/);if(m){assert.ok(text);return logs[m[1]] || '';}
    throw new Error(`unexpected ${address}`);
  };
  return {url,get};
}
const now=Date.parse('2026-11-20T12:00:00Z'),later='2026-11-27T12:00:00Z',quiet=()=>{};
const checked=(run,status='success')=>[{id:run*100,name:'scope',attempt:1,status:'success'},{id:run*100+1,name:'check-image',status}];
const kept=run=>[{id:run*1000,name:'check-image',expired:false,expires_at:later}];
const proof=(head,fingerprint,marker='CI_IMAGE_V1 ')=>JSON.stringify({content:marker+JSON.stringify({head,fingerprint})})+'\n';
const find=(f,over={})=>findPriorImage({sha:'m',workflow:'web-app/ci.yml',fingerprint:'f',get:f.get,url:f.url,now,probe:async()=>true,log:quiet,...over});

test('a merge takes the newest PR run of its suite that attested its image fingerprint and still holds the image',async()=>{
  const f=forgejo({jobs:{10:checked(10),11:checked(11)},artifacts:{10:kept(10),11:kept(11)},logs:{1000:proof('h2','f'),1100:proof('h2','other')}});
  const prior=await find(f);
  assert.equal(prior.run,10);assert.equal(prior.artifact.id,10000);assert.equal(prior.pull,25);
});

test('a merge builds its image when no run matches: other inputs or version, a failed check, an expiring image, a release proof, or no PR',async()=>{
  const one=(over={})=>forgejo({jobs:{10:checked(10)},artifacts:{10:kept(10)},logs:{1000:proof('h2','f')},...over});
  assert.equal(await find(one({logs:{1000:proof('h2','other')}})),null);
  assert.equal(await find(one({jobs:{10:checked(10,'failure')}})),null);
  assert.equal(await find(one({artifacts:{10:[{id:1,name:'check-image',expired:false,expires_at:'2026-11-20T12:30:00Z'}]}})),null);
  // A release build's proof of the same fingerprint, under its own marker, is not an image's.
  assert.equal(await find(one({logs:{1000:proof('h2','f','CI_BUILD_V1 ')}})),null);
  assert.equal(await find(one({logs:{1000:proof('h1','f')}})),null,'a proof for another head');
  assert.equal(await find(forgejo({pull:{}})),null);
  await assert.rejects(find(one(),{probe:async()=>false}),/can't be downloaded/);
});

test("the merge takes the kept image and what the PR's check recorded of it",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prior-image-download-')),saved=globalThis.fetch,url='https://forgejo.test/api/v1/repos/o/r';
  const record={name:'ci-o-r:h2-1234',id:`sha256:${'c'.repeat(64)}`,version:'v0.1.4'};
  const zip=files=>zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,new TextEncoder().encode(text)])));
  try {
    globalThis.fetch=async address=>{assert.match(String(address),/\/actions\/artifacts\/7\/zip$/);return new Response(zip({'image.tar':'image','image.json':JSON.stringify(record)}));};
    assert.deepEqual(await download({run:10,artifact:{id:7}},{directory:path.join(root,'kept'),url}),record);
    assert.equal(fs.readFileSync(path.join(root,'kept/image.tar'),'utf8'),'image');
    globalThis.fetch=async()=>new Response(zip({'image.json':'{"name":"x"}'}));
    await assert.rejects(download({run:10,artifact:{id:7}},{directory:path.join(root,'bad'),url}),/names no image/);
  } finally {globalThis.fetch=saved;fs.rmSync(root,{recursive:true,force:true});}
});
