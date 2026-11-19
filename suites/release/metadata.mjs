import fs from 'node:fs';
import path from 'node:path';
import {hash} from '../lib.mjs';
// Every release lists its files' SHA-256 in SHA256SUMS, as sha256sum -c reads it.
export function metadataFiles(records) {
  if(!records.length)return {};
  if(records.some(file=>file.name==='SHA256SUMS'))throw new Error('release metadata name collides: SHA256SUMS');
  return {SHA256SUMS:Buffer.from([...records].sort((a,b)=>a.name.localeCompare(b.name)).map(file=>`${file.sha256}  ${file.name}\n`).join(''))};
}
export function releaseMetadata(directory='dist') {
  const records=fs.readdirSync(directory).map(name=>{const data=fs.readFileSync(path.join(directory,name));return {name,size:data.length,sha256:hash(data)};});
  for(const [file,bytes] of Object.entries(metadataFiles(records)))fs.writeFileSync(path.join(directory,file),bytes);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/release/metadata.mjs'))releaseMetadata();
