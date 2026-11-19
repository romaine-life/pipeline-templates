import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {unzipSync} from 'fflate';
import {packageAssets,assetName} from '../release/assets.mjs';
import {dependencies} from '../release/dependencies.mjs';
import {validateDependencyOwnership} from '../release/selection.mjs';
import {metadataFiles} from '../release/metadata.mjs';
import {releasePlan} from '../release/plan.mjs';
import {hash,run,suites} from '../lib.mjs';
import {fleetEntry} from './fleet-entry.mjs';

async function fixture(fn) {
  const cwd=process.cwd(),env={...process.env},fetch=globalThis.fetch,root=fs.mkdtempSync(path.join(os.tmpdir(),'asset-contract-'));
  try {process.chdir(root);process.env.CI_CACHE_ROOT=path.join(root,'cache');process.env.VERSION='v1.2.3';await fn(root);}
  finally {globalThis.fetch=fetch;process.chdir(cwd);process.env=env;fs.rmSync(root,{recursive:true,force:true});}
}
const write=(file,data='payload')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
test('a Windows-only dependency is staged once and both Rust target parts assemble without duplicate names',()=>fixture(async()=>{
  const linux='x86_64-unknown-linux-gnu',windows='x86_64-pc-windows-msvc',bytes=Buffer.from('pinned DLL');
  const cfg={version:1,release:{toolchains:['rust'],rustTargets:[{target:linux},{target:windows}],dependencies:[{toolchain:'rust',targets:[windows],url:'https://artifacts.home.romaine.life/fzt.dll',sha256:hash(bytes),destination:'dist/fzt.dll'}]}};
  const {dependencies:downloads,...release}=cfg.release;fs.mkdirSync('release',{recursive:true});fs.writeFileSync('release/dependencies.json',JSON.stringify(downloads));fleetEntry({...cfg,suites:['release'],release});let fetched=0;globalThis.fetch=async()=>{fetched++;return new Response(bytes);};
  for(const target of [linux,windows]) {
    process.env.RELEASE_TARGET=target;process.env.RELEASE_PART=`rust-${target}`;
    await dependencies('rust');write(`dist/spotify_player-${target}${target===windows?'.exe':''}`);
    packageAssets({kind:'rust'});assert.equal(fs.existsSync('dist/fzt.dll'),target===windows);
    fs.cpSync('dist',`parts/${target}`,{recursive:true});fs.rmSync('dist',{recursive:true,force:true});
  }
  assert.equal(fetched,1);run(process.execPath,[path.join(suites,'release/assemble.mjs')]);assert.deepEqual(fs.readdirSync('dist').sort(),['fzt.dll','spotify_player-linux-amd64','spotify_player-windows-amd64.exe']);
  cfg.release.dependencies[0].targets=[linux,windows];assert.throws(()=>validateDependencyOwnership(cfg),/several targets/);
}));
test('files at the top of dist/ publish under their own names, and a folder as its ZIP',()=>fixture(async()=>{
  write('dist/tmux.exe');write('dist/at-protocol.txt');write('dist/SpireLens/SpireLens.dll');
  packageAssets({kind:'cmake'});assert.deepEqual(fs.readdirSync('dist').sort(),['SpireLens-'+(process.platform==='win32'?'windows.zip':'linux.tar.gz'),'at-protocol.txt','tmux.exe']);
}));
test('default names and target overrides preserve native consumers, and C-shared Go gets its own Windows part',()=>{
  assert.equal(assetName('coach-x86_64-pc-windows-msvc.exe',{kind:'rust',target:'x86_64-pc-windows-msvc'}),'coach-windows-amd64.exe');
  const plan=releasePlan({release:{toolchains:['go']}},[{id:'cli',buildmode:'',targets:[{goos:'linux',goarch:'amd64'}]},{id:'lib',buildmode:'c-shared',targets:[{goos:'windows',goarch:'amd64'}]}]);
  assert.deepEqual(plan.matrix.include.map(p=>[p.id,p.runner]),[['go','ubuntu-latest'],['go-windows-amd64-c-shared','windows-latest']]);
});
test('every release lists its files and their SHA-256 in SHA256SUMS, external parts included',()=>{
  const records=[{name:'macos.tar.gz',size:4,sha256:'b'.repeat(64)},{name:'local.exe',size:3,sha256:'a'.repeat(64)}];
  assert.equal(metadataFiles(records).SHA256SUMS.toString(),`${'a'.repeat(64)}  local.exe
${'b'.repeat(64)}  macos.tar.gz
`);
  assert.deepEqual(metadataFiles([]),{});
  assert.throws(()=>metadataFiles([{name:'SHA256SUMS',size:1,sha256:'c'.repeat(64)}]),/collides/);
});
