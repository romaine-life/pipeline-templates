import fs from 'node:fs';
import {selected,validateDependencyOwnership} from './selection.mjs';
import path from 'node:path';
import {config} from '../config.mjs';
import os from 'node:os';
import {hash,kept,run} from '../lib.mjs';
import {tar} from '../tools.mjs';
export async function dependencies(kind) {
  const cfg=config();validateDependencyOwnership(cfg);
  for (const dependency of cfg.release?.dependencies || []) {
    if (!selected(dependency,kind,cfg)) continue;
    let url=dependency.url,sha=dependency.sha256;
    if (dependency.lock) {
      const fields=fs.readFileSync(dependency.lock,'utf8').trim().split(/\s+/);
      if (fields.length!==2 || !/^[\w.+-]+$/.test(fields[0]) || !/^[0-9a-f]{64}$/.test(fields[1])) throw new Error('dependency lock is exactly tag sha256');
      url=url.replace('{tag}',encodeURIComponent(fields[0]));sha=fields[1];
    }
    const file=path.join(kept('release-inputs'),sha);
    if (!fs.existsSync(file) || hash(fs.readFileSync(file))!==sha) {
      const headers={};
      if (new URL(url).hostname==='forgejo.romaine.life') {
        if (!process.env.DEPENDENCY_TOKEN) throw new Error('Forgejo release dependency requires DEPENDENCY_TOKEN');
        headers.Authorization=`token ${process.env.DEPENDENCY_TOKEN}`;
      }
      const response=await fetch(url,{headers,signal:AbortSignal.timeout(120000),redirect:'error'});
      if (!response.ok) throw new Error(`release dependency download: HTTP ${response.status}`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if (hash(bytes)!==sha) throw new Error('release dependency checksum mismatch');
      const temp=`${file}.${process.pid}`;fs.writeFileSync(temp,bytes);
      try {fs.renameSync(temp,file);}catch(error){fs.unlinkSync(temp);if (!fs.existsSync(file))throw error;}
    }
    fs.mkdirSync(path.dirname(dependency.destination),{recursive:true});
    if (!dependency.extract) {fs.copyFileSync(file,dependency.destination);continue;}
    // One file out of an archive (dependency.extract): Windows' tar reads zip and 7z as well as tarballs.
    const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'release-input-'));
    try {
      run(tar,['-xf',file,'-C',temp,dependency.extract]);
      fs.copyFileSync(path.join(temp,dependency.extract),dependency.destination);
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
}
