import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deployStatic} from '../web-app/static.mjs';

test('Static Web App upload keeps its token out of arguments and cleans failed containers',()=>{
  const cwd=process.cwd(),env={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'static-upload-'));
  try {
    process.chdir(dir);fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','site');
    Object.assign(process.env,{GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main'});
    for (const failure of [false,true]) {
      const calls=[];const execute=(cmd,args)=>calls.push([cmd,args]);
      const read=(cmd,args,opts)=>{
        calls.push([cmd,args]);
        if (cmd==='az') return 'secret-only-in-environment';
        if (args[0]==='create') {assert.equal(opts.env.INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN,'secret-only-in-environment');return 'a'.repeat(64);}
        return failure ? '1' : '0';
      };
      const upload=()=>deployStatic({staticApp:'app',resourceGroup:'rg'},execute,read);
      if (failure) assert.throws(upload,/upload failed/);else upload();
      assert.equal(JSON.stringify(calls).includes('secret-only-in-environment'),false);
      assert.deepEqual(calls.at(-1),['docker',['rm','-f','a'.repeat(64)]]);
    }
    process.env.GITHUB_EVENT_NAME='pull_request';
    assert.throws(()=>deployStatic({}),/publish|default|release/i);
  } finally {process.chdir(cwd);process.env=env;fs.rmSync(dir,{recursive:true,force:true});}
});
