import fs from 'node:fs';
import path from 'node:path';
import {config} from '../config.mjs';
fs.mkdirSync('dist',{recursive:true});
const seen=new Set();
for (const part of fs.readdirSync('parts',{withFileTypes:true})) {
  if (!part.isDirectory()) throw new Error('expected a directory for each build artifact');
  for (const file of fs.readdirSync(path.join('parts',part.name),{withFileTypes:true})) {
    if (!file.isFile() || seen.has(file.name)) throw new Error(`duplicate or unflattened release asset: ${file.name}`);
    seen.add(file.name);fs.copyFileSync(path.join('parts',part.name,file.name),path.join('dist',file.name));
  }
}
const required=config().release?.assets || [];
for (const file of required) if (!fs.existsSync(file)) throw new Error(`release omitted required asset: ${file}`);
if (!seen.size) throw new Error('release assembly has no assets');
