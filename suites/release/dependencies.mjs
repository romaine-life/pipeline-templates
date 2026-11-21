import fs from 'node:fs';
import {selected,validateDependencyOwnership} from './selection.mjs';
import path from 'node:path';
import {config} from '../config.mjs';
import {hash,kept} from '../lib.mjs';
import {extract,fileVersion} from './archive.mjs';
// A lock file: exactly `<tag> <sha256>`.
export function readLock(file) {
  const fields=fs.readFileSync(file,'utf8').trim().split(/\s+/);
  if (fields.length!==2 || !/^[\w.+-]+$/.test(fields[0]) || !/^[0-9a-f]{64}$/.test(fields[1])) throw new Error('dependency lock is exactly tag sha256');
  return {tag:fields[0],sha256:fields[1]};
}
export async function dependencies(kind) {
  const cfg=config();validateDependencyOwnership(cfg);
  for (const dependency of cfg.release?.dependencies || []) {
    if (!selected(dependency,kind,cfg)) continue;
    let url=dependency.url,sha=dependency.sha256,tag;
    if (dependency.lock) {
      if (dependency.latest && !fs.existsSync(dependency.lock)) throw new Error(`${dependency.lock} is missing: the dependency take-up (Suite release dependencies, run from the Actions tab) pins ${dependency.latest}`);
      ({tag,sha256:sha}=readLock(dependency.lock));
      url=url.replace('{tag}',encodeURIComponent(tag));
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
    if (!dependency.extract) fs.copyFileSync(file,dependency.destination);
    else await extract(file,dependency.extract,dependency.destination);
    // The pin names the version its file reads as, which a release that builds nothing numbers on.
    if (dependency.version) {
      const version=fileVersion(fs.readFileSync(dependency.destination),dependency.version);
      if (version!==tag) throw new Error(`${dependency.destination} reads as ${version}, but ${dependency.lock} pins ${tag}`);
    }
  }
}
