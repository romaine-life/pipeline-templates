import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {hash,run} from '../lib.mjs';
import {tar} from '../tools.mjs';
import {dependencies} from '../release/dependencies.mjs';
import {archives} from '../release/archives.mjs';
import {unzipSync} from 'fflate';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';
test('pinned release dependencies are verified once and archive recipes reuse the files',async()=>{
  const cwd=process.cwd(),oldFetch=globalThis.fetch,oldCache=process.env.CI_CACHE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'release-inputs-'));
  let fetches=0;const bytes=Buffer.from('pinned dependency');
  try{
    process.chdir(root);process.env.CI_CACHE_ROOT=path.join(root,'cache');fs.writeFileSync('.goreleaser.yaml','{version: 2, builds: [{id: app, main: ., targets: [linux_amd64_v1]}]}');
    fs.writeFileSync('dependency.lock',`v1.0.0 ${hash(bytes)}`);
    fs.mkdirSync('release');fs.writeFileSync('release/dependencies.json',JSON.stringify([{url:'https://artifacts.home.romaine.life/dependency/{tag}',lock:'dependency.lock',destination:'dist/dependency.bin'}]));
    fleetEntry(({version:1,suites:['release'],release:{archives:[{name:'bundle.zip',sources:['dist/dependency.bin']}]}}));
    globalThis.fetch=async()=>{fetches++;return new Response(bytes);};
    await dependencies('go');await dependencies('go');assert.equal(fetches,1);
    archives('go');assert.equal(Buffer.from(unzipSync(fs.readFileSync('dist/bundle.zip'))['dependency.bin']).toString(),bytes.toString());
    fs.writeFileSync(path.join(root,'cache/release-inputs',hash(bytes)),'corrupt');
    await dependencies('go');assert.equal(fetches,2);
    globalThis.fetch=async()=>new Response('wrong bytes');fs.unlinkSync(path.join(root,'cache/release-inputs',hash(bytes)));
    await assert.rejects(dependencies('go'),/checksum/);
  }finally{globalThis.fetch=oldFetch;process.chdir(cwd);if(oldCache===undefined)delete process.env.CI_CACHE_ROOT;else process.env.CI_CACHE_ROOT=oldCache;fs.rmSync(root,{recursive:true,force:true});}
});
test('a release dependency can be one file out of an archive',async()=>{
  const cwd=process.cwd(),oldFetch=globalThis.fetch,oldCache=process.env.CI_CACHE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'release-extract-'));
  try{
    process.chdir(root);process.env.CI_CACHE_ROOT=path.join(root,'cache');fs.writeFileSync('.goreleaser.yaml','{version: 2, builds: [{id: app, main: ., targets: [linux_amd64_v1]}]}');
    fs.mkdirSync('source/lib',{recursive:true});fs.writeFileSync('source/lib/runtime.dll','runtime');fs.writeFileSync('source/other.h','header');
    run(tar,['-czf','bundle.tar.gz','-C','source','lib/runtime.dll','other.h']);
    const bytes=fs.readFileSync('bundle.tar.gz');
    fs.mkdirSync('release');fs.writeFileSync('release/dependencies.json',JSON.stringify([{url:'https://artifacts.home.romaine.life/bundle.tar.gz',sha256:hash(bytes),extract:'lib/runtime.dll',destination:'dist/runtime.dll'}]));
    fleetEntry({version:1,suites:['release']});
    globalThis.fetch=async()=>new Response(bytes);
    await dependencies('go');
    assert.equal(fs.readFileSync('dist/runtime.dll','utf8'),'runtime');
    assert.deepEqual(fs.readdirSync('dist'),['runtime.dll']);
  }finally{globalThis.fetch=oldFetch;process.chdir(cwd);if(oldCache===undefined)delete process.env.CI_CACHE_ROOT;else process.env.CI_CACHE_ROOT=oldCache;fs.rmSync(root,{recursive:true,force:true});}
});
