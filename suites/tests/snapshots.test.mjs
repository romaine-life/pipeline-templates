import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash,run} from '../lib.mjs';
import {tar} from '../tools.mjs';
import {downloads,snapshotURL} from '../layout.mjs';
import {releasePlan} from '../release/plan.mjs';
import {dependencies} from '../release/dependencies.mjs';
import {extract,member,fileVersion} from '../release/archive.mjs';
import {fileURLToPath} from 'node:url';
import {pinnedSeries,takeUpSnapshots} from '../release/snapshots.mjs';
import {fleetEntry} from './fleet-entry.mjs';

const latest='https://artifacts.home.romaine.life/general/mgba/mGBA-build-latest-win64.7z';
const pattern='(\\d+\\.\\d+)-(\\d+)-[0-9a-f]{7,}';
const entries=[
  {latest,lock:'release/mgba.lock',extract:'*/mGBA.exe',destination:'dist/mGBA.exe',version:pattern},
  {latest,lock:'release/mgba.lock',extract:'*/LICENSE.txt',destination:'dist/mGBA-LICENSE.txt'},
];
async function inTemp(fn) {
  const cwd=process.cwd(),env={...process.env},fetch=globalThis.fetch,root=fs.mkdtempSync(path.join(os.tmpdir(),'snapshots-'));
  try {process.chdir(root);process.env.CI_CACHE_ROOT=path.join(root,'cache');await fn(root);}
  finally {globalThis.fetch=fetch;process.chdir(cwd);process.env=env;fs.rmSync(root,{recursive:true,force:true});}
}
// An archive like mGBA's: one top folder named for the build.
function archive(root,version='0.11-9187-e6c17152d',licence='licence') {
  const top=path.join(root,'source',`build-${version}`);fs.mkdirSync(top,{recursive:true});
  fs.writeFileSync(path.join(top,'mGBA.exe'),`MZ...${version}...${version}...`);fs.writeFileSync(path.join(top,'LICENSE.txt'),licence);
  run(tar,['-czf',path.join(root,'latest.tar.gz'),'-C',path.join(root,'source'),`build-${version}`]);
  fs.rmSync(path.join(root,'source'),{recursive:true,force:true});
  return fs.readFileSync(path.join(root,'latest.tar.gz'));
}

test('a latest download reads its pinned snapshot, and its lock is its only pin',()=>{
  const value=downloads(JSON.stringify(entries),[],'romaine-life/mgba');
  assert.equal(value[0].url,'https://artifacts.home.romaine.life/general/snapshots/romaine-life/mgba/{tag}/mGBA-build-latest-win64.7z');
  assert.equal(snapshotURL('romaine-life/mgba',latest),value[1].url);
  const one=fields=>JSON.stringify([{...entries[0],...fields}]);
  assert.throws(()=>downloads(one({lock:undefined,sha256:'a'.repeat(64)}),[],'o/r'),/takes a lock/);
  assert.throws(()=>downloads(one({url:'https://artifacts.home.romaine.life/x'}),[],'o/r'),/takes a lock/);
  assert.throws(()=>downloads(one({latest:'https://example.com/latest.7z'}),[],'o/r'),/Artifact Keeper or Forgejo/);
  assert.throws(()=>downloads(one({version:'no groups'}),[],'o/r'),/pattern with groups/);
  assert.throws(()=>downloads(JSON.stringify([{url:'https://artifacts.home.romaine.life/x',sha256:'a'.repeat(64),destination:'dist/x',version:pattern}]),[],'o/r'),/latest dependency/);
  assert.throws(()=>downloads(JSON.stringify([entries[0],{...entries[1],version:pattern}]),[],'o/r'),/more than one entry/);
  assert.throws(()=>downloads(JSON.stringify([entries[0],{...entries[1],latest:`${latest}.other`}]),[],'o/r'),/download different files/);
});

test('a release that builds nothing is one Linux part that packs its downloads',()=>{
  const plan=releasePlan({release:{dependencies:entries}});
  assert.deepEqual(plan.matrix.include,[{id:'files',toolchain:'files',target:'',features:'',noDefault:false,runner:'ubuntu-latest'}]);
  assert.equal(plan.local,true);
  assert.throws(()=>releasePlan({release:{}}),/must declare the builders/);
});

test('a release that builds nothing numbers on its pinned version, with version-from-manifest',()=>inTemp(async()=>{
  const release={fromManifest:true,dependencies:entries};
  assert.throws(()=>pinnedSeries({release}),/is missing: the dependency take-up/);
  fs.mkdirSync('release');fs.writeFileSync('release/mgba.lock',`0.11.9187 ${'a'.repeat(64)}\n`);
  assert.equal(pinnedSeries({release}),'v0.11.9187');
  assert.equal(pinnedSeries({release:{dependencies:entries}}),null,'without version-from-manifest it numbers on its tags');
  assert.equal(pinnedSeries({release:{...release,toolchains:['go']}}),null,'a build numbers on its manifest');
  assert.throws(()=>pinnedSeries({release:{fromManifest:true,dependencies:[entries[1]]}}),/the one download whose lock pins its version/);
}));

test('an extract path takes an archive\'s one top folder, and a version reads the same everywhere in its file',()=>{
  assert.equal(member(['top-1','top-1/mGBA.exe','top-1/mgba-sdl.exe'],'*/mGBA.exe'),'top-1/mGBA.exe');
  assert.equal(member(['ab/c','a.b/c'],'a.b/*'),'a.b/c');
  assert.equal(member([],'plain/path.dll'),'plain/path.dll');
  assert.throws(()=>member(['a/x.exe','b/x.exe'],'*/x.exe'),/names 2 files/);
  assert.throws(()=>member([],'*/x.exe'),/names 0 files/);
  assert.equal(fileVersion(Buffer.from('a 0.11-9187-e6c17152d b 0.11-9187-e6c17152d'),pattern),'0.11.9187');
  assert.throws(()=>fileVersion(Buffer.from('0.11-9187-e6c17152d 0.11-9188-1234567'),pattern),/several versions/);
  assert.throws(()=>fileVersion(Buffer.from('nothing'),pattern),/holds no version/);
});

test('the take-up copies a new newest file to its snapshot and pins it; a current pin moves nothing',()=>inTemp(async root=>{
  const source=latest.replace('.7z','.tar.gz'),local=entries.map(item=>({...item,latest:source}));
  const cfg={release:{dependencies:downloads(JSON.stringify(local),[],'romaine-life/mgba')}};
  const snapshot=version=>`https://artifacts.home.romaine.life/general/snapshots/romaine-life/mgba/${version}/mGBA-build-latest-win64.tar.gz`;
  let bytes=archive(root);
  const held=new Map(),puts=[];
  globalThis.fetch=async(url,options={})=>{
    url=String(url);
    if(url===source)return new Response(bytes);
    if(options.method==='PUT'){puts.push(url);held.set(url.replace('/api/v1/repositories/snapshots/artifacts/','/general/snapshots/'),Buffer.from(options.body));return new Response('',{status:201});}
    return held.has(url) ? new Response(held.get(url)) : new Response('missing',{status:404});
  };
  const signIn=async()=>'ak-token';
  let result=await takeUpSnapshots({cfg,signIn});
  assert.deepEqual(result,{locks:['release/mgba.lock'],moved:['mGBA-build-latest-win64.tar.gz (none) -> 0.11.9187']});
  assert.equal(fs.readFileSync('release/mgba.lock','utf8'),`0.11.9187 ${hash(bytes)}\n`);
  assert.deepEqual(puts,['https://artifacts.home.romaine.life/api/v1/repositories/snapshots/artifacts/romaine-life/mgba/0.11.9187/mGBA-build-latest-win64.tar.gz']);
  result=await takeUpSnapshots({cfg,signIn});
  assert.deepEqual(result.moved,[],'the pin is current');assert.equal(puts.length,1);

  // The release reads the pinned copy, checks the version it names, and packs the files.
  process.env.GITHUB_REPOSITORY='romaine-life/mgba';fleetEntry({suites:['release']},'romaine-life/mgba');
  fs.writeFileSync('release/dependencies.json',JSON.stringify(local));
  await dependencies('files');
  assert.deepEqual(fs.readdirSync('dist').sort(),['mGBA-LICENSE.txt','mGBA.exe']);
  assert.equal(fs.readFileSync('dist/mGBA-LICENSE.txt','utf8'),'licence');

  // A newer build: a new snapshot and pin. A snapshot address holding other bytes is refused.
  bytes=archive(root,'0.11-9188-1234567');
  result=await takeUpSnapshots({cfg,signIn});
  assert.deepEqual(result.moved,['mGBA-build-latest-win64.tar.gz 0.11.9187 -> 0.11.9188']);
  fs.writeFileSync('release/mgba.lock',`0.11.9187 ${'b'.repeat(64)}\n`);
  bytes=archive(root,'0.11-9187-e6c17152d','another licence');
  await assert.rejects(takeUpSnapshots({cfg,signIn}),/already holds another file/);

  // A pin whose file reads as another version is refused at the release.
  const pinned=held.get(snapshot('0.11.9188'));
  held.set(snapshot('0.11.9190'),pinned);
  fs.writeFileSync('release/mgba.lock',`0.11.9190 ${hash(pinned)}\n`);
  await assert.rejects(dependencies('files'),/reads as 0\.11\.9188, but release\/mgba\.lock pins 0\.11\.9190/);
}));

// A 7z like mGBA's (fixtures/mgba-like.7z): Windows' tar reads it, Linux's 7-Zip (tools.mjs).
test('a file comes out of a 7z archive\'s one top folder on either system',()=>inTemp(async()=>{
  const fixture=fileURLToPath(new URL('./fixtures/mgba-like.7z',import.meta.url));
  await extract(fixture,'*/mGBA.exe','out/mGBA.exe');
  assert.equal(fileVersion(fs.readFileSync('out/mGBA.exe'),pattern),'0.11.9187');
  await extract(fixture,'*/LICENSE.txt','out/LICENSE.txt');
  assert.equal(fs.readFileSync('out/LICENSE.txt','utf8'),'licence');
}));
