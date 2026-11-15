import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {zipSync} from 'fflate';
import {packageAssets} from '../release/assets.mjs';
import {archives} from '../release/archives.mjs';
import {metadataFiles} from '../release/metadata.mjs';
import {archiveSignatureName} from '../release/sign-linux.mjs';
import {releasePlan} from '../release/plan.mjs';
import {config} from '../config.mjs';
import {hash,run,suites} from '../lib.mjs';
const audit=JSON.parse(fs.readFileSync(new URL('./asset-contracts.json',import.meta.url),'utf8'));
test('every audited release and home-sync consumer keeps its published asset names through the real packager',()=>{
  const cwd=process.cwd(),env={...process.env},root=fs.mkdtempSync(path.join(os.tmpdir(),'asset-audit-'));
  try {
    process.chdir(root);process.env.CI_CACHE_ROOT=path.join(root,'cache');
    run(process.execPath,[path.join(suites,'tests/asset-audit-docs.mjs'),'--check']);
    assert.equal(audit.repositories.length,50);
    for(const row of audit.repositories) {
      if(!row.assets.length){assert.equal(row.homeAssets.length,0,row.repository);continue;}
      fs.writeFileSync('.ci.json',JSON.stringify(row.config));config();
      process.env.VERSION=row.tag;const published=new Map();
      for(const sample of row.samples) {
        process.env.RELEASE_TARGET=sample.target;process.env.RELEASE_PART=sample.part;process.env.RELEASE_TOOLCHAIN=sample.kind;
        fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');
        for(const file of sample.files){const source=path.join('dist',file);fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,file.endsWith('.zip')?zipSync({'payload.txt':Buffer.from('payload')}):'payload');}
        archives(sample.kind);packageAssets({kind:sample.kind,part:sample.part,target:sample.target});
        for(const file of fs.readdirSync('dist')){assert.equal(published.has(file),false,`${row.repository}: duplicate ${file}`);published.set(file,fs.readFileSync(path.join('dist',file)));}
      }
      for(const [name] of [...published])if(name.endsWith('.zip') && !published.has(archiveSignatureName(name)))published.set(archiveSignatureName(name),Buffer.from('signature name; cryptography is exercised by native fixtures'));
      const records=[...published].map(([name,bytes])=>({name,size:bytes.length,sha256:hash(bytes)}));
      for(const [name,bytes] of Object.entries(metadataFiles(records,row.config.release,{tag:row.tag,sha:'a'.repeat(40)}))){assert.equal(published.has(name),false);published.set(name,bytes);}
      for(const asset of [...row.assets,...row.homeAssets.map(name=>name.replaceAll('{tag}',row.tag))])assert.ok(published.has(asset),`${row.repository}: consumer asset disappeared: ${asset}; produced ${[...published.keys()].join(', ')}`);
      for(const external of releasePlan(row.config).external)for(const asset of external.assets)assert.ok(published.has(asset),`${row.repository}: external declaration ${asset}`);
    }
  } finally {process.chdir(cwd);process.env=env;fs.rmSync(root,{recursive:true,force:true});}
});
