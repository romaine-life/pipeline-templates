import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {unzipSync} from 'fflate';
import {packageAssets,assetName} from '../release/assets.mjs';
import {archives} from '../release/archives.mjs';
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
  const cfg={version:1,release:{toolchains:['rust'],rustTargets:[{target:linux},{target:windows}],dependencies:[{toolchain:'rust',targets:[windows],url:'https://artifacts.home.romaine.life/fzt.dll',sha256:hash(bytes),destination:'dist/fzt.dll'}],assetNames:{[`rust-${linux}`]:{[`spotify_player-${linux}`]:'spotify_player'},[`rust-${windows}`]:{[`spotify_player-${windows}.exe`]:'spotify_player.exe'}}}};
  fleetEntry((cfg));let fetched=0;globalThis.fetch=async()=>{fetched++;return new Response(bytes);};
  for(const target of [linux,windows]) {
    process.env.RELEASE_TARGET=target;process.env.RELEASE_PART=`rust-${target}`;
    await dependencies('rust');write(`dist/spotify_player-${target}${target===windows?'.exe':''}`);
    packageAssets({kind:'rust'});assert.equal(fs.existsSync('dist/fzt.dll'),target===windows);
    fs.cpSync('dist',`parts/${target}`,{recursive:true});fs.rmSync('dist',{recursive:true,force:true});
  }
  assert.equal(fetched,1);run(process.execPath,[path.join(suites,'release/assemble.mjs')]);assert.deepEqual(fs.readdirSync('dist').sort(),['fzt.dll','spotify_player','spotify_player.exe']);
  cfg.release.dependencies[0].targets=[linux,windows];assert.throws(()=>validateDependencyOwnership(cfg),/several targets/);
}));
test('rename maps extract loose CMake assets and package real directory ZIPs without changing the format',()=>fixture(async()=>{
  write('dist/cmake/mGBA.exe');write('dist/cmake/nointro.dat');write('dist/cmake/mGBA-LICENSE.txt');
  packageAssets({kind:'cmake',cfg:{release:{assetNames:{cmake:{'cmake/*':'*'}}}}});assert.deepEqual(fs.readdirSync('dist').sort(),['mGBA-LICENSE.txt','mGBA.exe','nointro.dat']);
  fs.rmSync('dist',{recursive:true});write('dist/cmake/tmux.exe');
  packageAssets({kind:'cmake',cfg:{release:{assetNames:{cmake:{cmake:'tmux-windows-{tag}.zip'}}}}});
  assert.deepEqual(Object.keys(unzipSync(fs.readFileSync('dist/tmux-windows-v1.2.3.zip'))),['tmux.exe']);
}));
test('per-target archives rename their contained executable and consume it before assembly',()=>fixture(async()=>{
  const target='x86_64-pc-windows-msvc';process.env.RELEASE_TARGET=target;
  fleetEntry(({version:1,release:{toolchains:['rust'],rustTargets:[{target}],archives:[{toolchain:'rust',targets:[target],name:`tuimail-${target}.zip`,sources:[`dist/tuimail-${target}.exe`],entries:{[`tuimail-${target}.exe`]:'tuimail.exe'}}]}}));
  write(`dist/tuimail-${target}.exe`);archives('rust');assert.equal(fs.existsSync(`dist/tuimail-${target}.exe`),false);
  assert.deepEqual(Object.keys(unzipSync(fs.readFileSync(`dist/tuimail-${target}.zip`))),['tuimail.exe']);
}));
test('default names and target overrides preserve native consumers, and C-shared Go gets its own Windows part',()=>{
  assert.equal(assetName('coach-x86_64-pc-windows-msvc.exe',{kind:'rust',target:'x86_64-pc-windows-msvc',cfg:{}}),'coach-windows-amd64.exe');
  assert.equal(assetName('home-sync-windows-amd64.exe',{kind:'go',cfg:{release:{goTargets:[{goos:'windows',goarch:'amd64'}],assetNames:{'go-windows-amd64':{'*-windows-amd64.exe':'*.exe'}}}}}),'home-sync.exe');
  const plan=releasePlan({release:{toolchains:['go'],goTargets:[{goos:'linux',goarch:'amd64'},{goos:'windows',goarch:'amd64',buildmode:'c-shared'}]}});
  assert.deepEqual(plan.matrix.include.map(p=>[p.id,p.runner]),[['go','ubuntu-latest'],['go-windows-amd64-c-shared','windows-latest']]);
});
test('joined checksum manifests cover external parts and preserve Spotify metadata field names',()=>{
  const records=[{name:'local.exe',size:3,sha256:'a'.repeat(64)},{name:'macos.tar.gz',size:4,sha256:'b'.repeat(64)}];
  const files=metadataFiles(records,{checksumFiles:['*.exe'],checksumManifest:'SHA256SUMS',manifest:'session-release.json'},{tag:'v1',sha:'c'.repeat(40)});
  assert.match(files.SHA256SUMS.toString(),/macos.tar.gz/);assert.equal(files['local.exe.sha256'].toString(),'a'.repeat(64)+'\n');
  const manifest=JSON.parse(files['session-release.json']);assert.equal(manifest.commit,'c'.repeat(40));assert.equal(manifest.files['macos.tar.gz'].sha256,'b'.repeat(64));
});
