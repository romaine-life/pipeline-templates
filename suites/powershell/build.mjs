import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {zipDirectory} from '../release/zip.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'commands-'));
try {
  fs.cpSync('commands',temp,{recursive:true});
  const names=fs.readdirSync(temp).filter(f=>f.endsWith('.ps1')).map(f=>path.basename(f,'.ps1')).sort();
  fs.writeFileSync(path.join(temp,'commands.json'),JSON.stringify(names));
  const name=(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).split('/').at(-1);
  fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(`dist/${name}-commands.zip`,zipDirectory(temp));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
