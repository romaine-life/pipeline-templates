import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {config} from '../config.mjs';
import {run} from '../lib.mjs';
for (const cwd of config().web?.packages || ['.']) {
  const npm=process.platform==='win32' ? 'npm.cmd' : 'npm';
  const options={cwd,shell:process.platform==='win32',env:{...process.env,CI:'true'}};
  run(npm,['ci','--prefer-offline','--no-audit','--no-fund'],options);
  run(npm,['run','build'],options);
  const source=path.resolve(cwd,'dist');
  if (!fs.existsSync(source)) throw new Error(`${cwd}: npm build must produce dist/`);
  const name=cwd==='.' ? path.basename(process.cwd()) : path.basename(cwd);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'npm-release-'));
  try {
    fs.cpSync(source,temp,{recursive:true});
    if(cwd==='.')fs.rmSync(source,{recursive:true,force:true});
    fs.mkdirSync('dist',{recursive:true});fs.cpSync(temp,path.resolve('dist',name),{recursive:true});
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
