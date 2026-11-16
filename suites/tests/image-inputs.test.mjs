import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run,capture} from '../lib.mjs';
import {imageInputs,imageFingerprint,imageLayout} from '../image-inputs.mjs';
import {fingerprint} from '../fingerprints.mjs';
import {config} from '../config.mjs';
test('image identity follows context COPY sources and declared inputs, independent of binaries, upstream Dockerfile and release fields',async()=>{
  const cwd=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'image-inputs-'));
  try {
    process.chdir(root);fs.mkdirSync('k8s/image',{recursive:true});
    const cfg={version:1,cluster:{dockerfile:'k8s/image/Dockerfile',context:'k8s/image'},inputs:{'cluster-service.image':['image.lock']}};
    fs.writeFileSync('k8s/image/Dockerfile','FROM scratch\nCOPY runtime.conf /runtime.conf\n');fs.writeFileSync('k8s/image/runtime.conf','one');fs.writeFileSync('main.rs','source');fs.writeFileSync('Dockerfile','upstream');fs.writeFileSync('image.lock','one');
    run('git',['init','--initial-branch=main']);run('git',['config','user.name','fixture']);run('git',['config','user.email','fixture@noreply.romaine.life']);
    const commit=()=>{run('git',['add','.']);run('git',['commit','-m','fixture']);};commit();
    assert.deepEqual(imageLayout(),{context:'.',dockerfile:'Dockerfile',ignore:['.dockerignore','Dockerfile.dockerignore']});
    assert.ok(imageInputs(cfg,'cluster').includes('k8s/image/runtime.conf'));
    const initial=imageFingerprint(cfg,'cluster'),suite='a'.repeat(40),check=await fingerprint('cluster-service.image','ubuntu-latest',cfg,suite);
    fs.writeFileSync('main.rs','new source');fs.writeFileSync('Dockerfile','new upstream');commit();
    assert.equal(imageFingerprint(cfg,'cluster'),initial);assert.equal(await fingerprint('cluster-service.image','ubuntu-latest',cfg,suite),check);
    for(const file of ['k8s/image/runtime.conf','image.lock','k8s/image/Dockerfile.dockerignore']) {
      fs.writeFileSync(file,'changed');commit();assert.notEqual(imageFingerprint(cfg,'cluster'),initial);
    }
    assert.throws(()=>imageLayout({context:'../escape'}),/relative path/);
    fs.writeFileSync('.ci.json',JSON.stringify({version:1,release:{image:'cluster'},cluster:{image:'forgejo.romaine.life/test/app',pinFile:'values.yaml'}}));assert.throws(()=>config(),/runtimeChecks/);
  }finally {process.chdir(cwd);fs.rmSync(root,{recursive:true,force:true});}
});
