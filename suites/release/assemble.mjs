import fs from 'node:fs';
import path from 'node:path';
import {config, currentRepository} from '../config.mjs';
import {assembledProviders, providerType} from './tofu-provider.mjs';
fs.mkdirSync('dist',{recursive:true});
const seen=new Set();
for (const part of fs.readdirSync('parts',{withFileTypes:true})) {
  if (!part.isDirectory()) throw new Error('expected a directory for each build artifact');
  for (const file of fs.readdirSync(path.join('parts',part.name),{withFileTypes:true})) {
    if (!file.isFile() || seen.has(file.name)) throw new Error(`duplicate or unflattened release asset: ${file.name}`);
    seen.add(file.name);fs.copyFileSync(path.join('parts',part.name,file.name),path.join('dist',file.name));
  }
}
if (!seen.size) throw new Error('release assembly has no assets');
// An OpenTofu provider's release holds a package for each platform every provider ships for.
if (config().release?.tofuProvider) assembledProviders([...seen], providerType(currentRepository()));
