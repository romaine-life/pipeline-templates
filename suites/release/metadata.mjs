import fs from 'node:fs';
import path from 'node:path';
import {hash} from '../lib.mjs';
import {config} from '../config.mjs';
export function metadataFiles(records,settings,{tag=process.env.VERSION,sha=process.env.SOURCE_SHA || process.env.GITHUB_SHA}={}) {
  const generated={},name=value=>value.replaceAll('{tag}',tag || '').replaceAll('{version}',(tag || '').replace(/^v/,''));
  const files=Object.fromEntries([...records].sort((a,b)=>a.name.localeCompare(b.name)).map(file=>[file.name,{size:file.size,sha256:file.sha256}]));
  function add(file,bytes){if(files[file] || generated[file])throw new Error(`release metadata name collides: ${file}`);generated[file]=Buffer.from(bytes);}
  for(const pattern of settings.checksumFiles || []) {
    const escaped=name(pattern).split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*'),match=new RegExp(`^${escaped}$`);
    const selected=Object.keys(files).filter(file=>match.test(file));if(!selected.length)throw new Error(`checksum pattern matched no release assets: ${pattern}`);
    for(const file of selected)add(`${file}.sha256`,files[file].sha256+'\n');
  }
  if(settings.checksumManifest)add(name(settings.checksumManifest),Object.keys(files).sort().map(file=>`${files[file].sha256}  ${file}`).join('\n')+'\n');
  if(settings.manifest) {
    for(const [file,data] of Object.entries(generated))files[file]={size:data.length,sha256:hash(data)};
    add(name(settings.manifest),JSON.stringify({tag,commit:sha,files}));
  }
  return generated;
}
export function releaseMetadata(directory='dist',cfg=config()) {
  const records=fs.readdirSync(directory).map(name=>{const data=fs.readFileSync(path.join(directory,name));return {name,size:data.length,sha256:hash(data)};});
  for(const [file,bytes] of Object.entries(metadataFiles(records,cfg.release || {})))fs.writeFileSync(path.join(directory,file),bytes);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/release/metadata.mjs'))releaseMetadata();
