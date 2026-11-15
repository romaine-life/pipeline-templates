import fs from 'node:fs';
import {selected} from './selection.mjs';
import path from 'node:path';
import {zipSync} from 'fflate';
import os from 'node:os';
import {run} from '../lib.mjs';
import {directoryEntries} from './zip.mjs';
import {config} from '../config.mjs';
export function archives(kind) {
  const cfg=config(),consumed=new Set();
  for (const archive of cfg.release?.archives || []) {
    if (!selected(archive,kind,cfg)) continue;
    const files=Object.create(null);
    for (const file of archive.sources) {
      if(fs.statSync(file).isDirectory()) {
        for(const [name,bytes] of Object.entries(directoryEntries(file))) {if(files[name])throw new Error('archive entries collide');files[name]=bytes;}
      } else {
        const name=archive.entries?.[path.basename(file)] || path.basename(file);if(files[name])throw new Error('archive source basenames collide');files[name]=fs.readFileSync(file);
      }
      if(path.resolve(file).startsWith(path.resolve('dist')+path.sep))consumed.add(file);
    }
    fs.mkdirSync('dist',{recursive:true});
    const name=archive.name.replaceAll('{tag}',process.env.VERSION || '').replaceAll('{version}',(process.env.VERSION || '').replace(/^v/,''));
    if(name.endsWith('.zip'))fs.writeFileSync(path.join('dist',name),zipSync(files));
    else {
      const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'release-archive-'));
      try {for(const [file,data] of Object.entries(files)){const dest=path.join(temp,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data);}run('tar',['-czf',path.resolve('dist',name),'-C',temp,'.']);}
      finally{fs.rmSync(temp,{recursive:true,force:true});}
    }
  }
  for(const file of consumed)fs.rmSync(file,{recursive:true,force:true});
}
