import test from 'node:test';
import assert from 'node:assert/strict';
import {packagingChanged} from '../release/inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {capture,run,suites} from '../lib.mjs';
import {spawnSync} from 'node:child_process';

const cfg={version:1,web:{packages:['frontend']},release:{toolchains:['go','rust','npm','cmake','dotnet','python'],rustTargets:[{target:'x86_64-pc-windows-msvc'}]}};
test('ordinary source changes never rebuild release targets on a PR',()=>{
  for(const file of ['cmd/app/main.go','src/main.rs','src/native.cpp','App/Program.cs','src/tool.py','frontend/src/main.ts'])assert.equal(packagingChanged([file],cfg,()=>null),false,file);
  for(const file of ['cmd/app/app.manifest','resources/app.rc','resources/app.ico','vendor/gui.syso','installer/setup.wxs','ci/package/windows.ps1','scripts/build-release.mjs','Cargo.lock','go.sum','frontend/package-lock.json','uv.lock','App/packages.lock.json'])assert.equal(packagingChanged([file],cfg,()=>null),true,file);
  assert.equal(packagingChanged(['Cargo.lock'],{release:{toolchains:['go']}},()=>null),false);
  assert.equal(packagingChanged(['pinned-library.lock'],{release:{dependencies:[{lock:'pinned-library.lock'}]}},()=>null),true);
  assert.equal(packagingChanged(['unrelated/package-lock.json'],cfg,()=>null),false);
  for(const file of ['CMakeLists.txt','App/App.csproj','pyproject.toml'])assert.equal(packagingChanged([file],cfg,()=>null),true);
});
test('the release CLI in a real git checkout separates source publication from packaging',()=>{
  const cwd=process.cwd(),env={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'packaging-scope-'));
  try {
    process.chdir(dir);fs.writeFileSync('.ci.json',JSON.stringify({version:1,release:{toolchains:['rust']}}));
    fs.writeFileSync('Cargo.toml','[package]\nname="app"\nversion="1.0.0"\n[features]\ndefault=[]\n');
    fs.mkdirSync('src');fs.writeFileSync('src/main.rs','fn main() {}');
    run('git',['init','-b','main']);
    const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);};
    commit();const base=capture('git',['rev-parse','HEAD']);
    fs.writeFileSync('src/main.rs','fn main() { println!("source-only"); }');commit();
    const cli=()=>{
      const result=spawnSync(process.execPath,[path.join(suites,'inputs.mjs'),'release'],{cwd:dir,encoding:'utf8',timeout:10000,env:{...env,GITHUB_ACTIONS:'false',GITHUB_EVENT_NAME:'pull_request',BASE:base,GITHUB_OUTPUT:path.join(dir,'outputs')}});
      assert.equal(result.status,0,`release CLI exited ${result.status}: ${result.stderr || result.error}`);
      return fs.readFileSync('outputs','utf8');
    };
    let outputs=cli();
    assert.match(outputs,/^build=true$/m);assert.match(outputs,/^package=false$/m);
    fs.appendFileSync('Cargo.toml','[profile.release]\nlto=true\n');commit();fs.writeFileSync('outputs','');
    outputs=cli();assert.match(outputs,/^package=true$/m);
  } finally {process.chdir(cwd);process.env=env;fs.rmSync(dir,{recursive:true,force:true});}
});
test('packaging compares only release configuration and Cargo feature/profile semantics',()=>{
  const check=(next,before=cfg)=>packagingChanged(['.ci.json'],next,()=>JSON.stringify(before));
  assert.equal(check({...cfg,docs:{required:['README.md']},go:{platforms:['windows-latest']},rust:{platforms:['ubuntu-latest']}}),false);
  assert.equal(check({...cfg,release:{...cfg.release,windowsGui:['./cmd/app']}}),true);
  assert.equal(check({...cfg,rust:{features:['tls']}}),true);
  const cargo='[package]\nname="app"\nversion="1.0.0"\n[features]\ndefault=["tls"]\ntls=[]\n[profile.release]\nlto=true\n';
  const compare=after=>packagingChanged(['Cargo.toml'],cfg,()=>cargo,()=>after);
  assert.equal(compare(cargo+'\n[dependencies]\nserde="1"\n'),false);
  assert.equal(compare(cargo.replace('default=["tls"]','default=[]')),true);
  assert.equal(compare(cargo.replace('lto=true','lto=false')),true);
  assert.equal(compare('# formatting only\n'+cargo),false);
  assert.equal(packagingChanged(['Cargo.toml'],{release:{toolchains:['go']}},()=>cargo,()=>null),false);
  const npm=JSON.stringify({scripts:{build:'vite build',test:'vitest'}});
  assert.equal(packagingChanged(['frontend/package.json'],cfg,()=>npm,()=>npm.replace('vitest','vitest run')),false);
  assert.equal(packagingChanged(['frontend/package.json'],cfg,()=>npm,()=>npm.replace('vite build','vite build --minify')),true);
});
