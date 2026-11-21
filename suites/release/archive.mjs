import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture,run} from '../lib.mjs';
import {tar,tool} from '../tools.mjs';

// One file out of a downloaded archive (a release dependency's extract). Windows' tar reads zip
// and 7z as well as tarballs; on Linux a 7z is 7-Zip's, which GNU tar can't read.
const sevenZipMagic=Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]);
function isSevenZip(file) {
  const head=Buffer.alloc(6),fd=fs.openSync(file,'r');
  try {fs.readSync(fd,head,0,6,0);} finally {fs.closeSync(fd);}
  return head.equals(sevenZipMagic) && process.platform!=='win32';
}
export async function members(file) {
  if(isSevenZip(file))return capture(await tool('sevenZip'),['l','-slt','-ba',file]).split('\n').filter(line=>line.startsWith('Path = ')).map(line=>line.slice('Path = '.length).trim());
  return capture(tar,['-tf',file]).split('\n').map(line=>line.trim().replace(/\/$/,'')).filter(Boolean);
}
// The member an extract path names: a `*` segment stands for any one name there, so an archive
// whose one top folder carries the build's name (mGBA-build-<date>-win64-<build>-<commit>/) is
// read the same way every time. It must name exactly one member.
export function member(names,pattern) {
  if(!pattern.includes('*'))return pattern;
  const literal=text=>text.replace(/[.+?^$()|[\]\\{}]/g,'\\$&');
  const segment=part=>new RegExp('^'+part.split('*').map(literal).join('[^/]*')+'$');
  const parts=pattern.split('/').map(segment);
  const found=names.filter(name=>{const items=name.split('/');return items.length===parts.length && items.every((item,i)=>parts[i].test(item));});
  if(found.length!==1)throw new Error(`extract ${pattern} names ${found.length} files in the archive, not one`);
  return found[0];
}
// Extracts the member an extract path names to destination.
export async function extract(file,pattern,destination) {
  const name=member(pattern.includes('*') ? await members(file) : [],pattern);
  const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'release-input-'));
  try {
    if(isSevenZip(file))run(await tool('sevenZip'),['x',file,`-o${temp}`,'-y','-bso0','-bsp0','--',name]);
    else run(tar,['-xf',file,'-C',temp,name]);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(path.join(temp,name),destination);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
// The version a file reads as: a pattern's groups joined by dots (0.11-9187-e6c1715 gives
// 0.11.9187 for mGBA's), the same at every place the file holds it.
export function fileVersion(bytes,pattern) {
  const found=new Set();
  for(const match of bytes.toString('latin1').matchAll(new RegExp(pattern,'g')))found.add(match.slice(1).join('.'));
  if(found.size!==1)throw new Error(found.size ? `the file reads as several versions: ${[...found].sort().join(', ')}` : `the file holds no version matching ${pattern}`);
  const [version]=found;
  if(!/^[\w.+-]+$/.test(version))throw new Error(`version ${version} isn't a tag`);
  return version;
}
