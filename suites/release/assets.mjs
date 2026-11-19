import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {run} from '../lib.mjs';
import {zipDirectory} from './zip.mjs';

// A Rust binary built for a target publishes under its platform: tuimail-x86_64-pc-windows-msvc.exe
// as tuimail-windows-amd64.exe. Anything else publishes under its own name.
export function assetName(name,{kind,target=''}={}) {
  const triple=kind==='rust' && target.match(/^(x86_64|aarch64)-(?:pc-windows-msvc|unknown-linux-gnu)$/);
  if(!triple || !(name.endsWith(`-${target}${target.includes('windows')?'.exe':''}`) || name.endsWith(`-${target}.dll`) || name.endsWith(`-${target}.so`)))return null;
  return name.replace(`-${target}`,`-${target.includes('windows')?'windows':'linux'}-${triple[1]==='x86_64'?'amd64':'arm64'}`);
}
export function packageAssets({kind=process.env.RELEASE_TOOLCHAIN,target=process.env.RELEASE_TARGET || ''}={}) {
  const root=path.resolve('dist'),temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'release-assets-')),out=path.join(temp,'out'),claimed=new Set(),names=new Set();
  fs.mkdirSync(out);
  function destination(name) {if(names.has(name))throw new Error(`duplicate published asset: ${name}`);names.add(name);return path.join(out,name);}
  function pack(dir,name) {
    if(name.endsWith('.zip'))fs.writeFileSync(destination(name),zipDirectory(dir));
    else if(name.endsWith('.tar.gz'))run('tar',['-czf',destination(name),'-C',dir,'.']);
    else throw new Error(`directory asset needs a .zip or .tar.gz published name: ${name}`);
  }
  function select(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/'),rename=assetName(relative,{kind,target});
      if(entry.isDirectory())select(file);
      if(rename) {if(entry.isDirectory())pack(file,rename);else if(entry.isFile())fs.copyFileSync(file,destination(rename));else throw new Error('release assets must be regular files');claimed.add(relative);}
      else if(!entry.isDirectory() && !entry.isFile())throw new Error('release assets must be regular files');
    }
  }
  try {
    select(root);
    for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
      if(claimed.has(entry.name))continue;
      const file=path.join(root,entry.name);
      if(entry.isFile())fs.copyFileSync(file,destination(entry.name));
      else if(entry.isDirectory()) {
        const remaining=path.join(temp,'remaining',entry.name);
        fs.cpSync(file,remaining,{recursive:true,filter:source=>!claimed.has(path.relative(root,source).replaceAll('\\','/'))});
        function populated(dir){return fs.readdirSync(dir,{withFileTypes:true}).some(item=>item.isFile() || item.isDirectory() && populated(path.join(dir,item.name)));}
        if(populated(remaining))pack(remaining,kind==='npm'?`${entry.name}-web.tar.gz`:`${entry.name}-${process.platform==='win32'?'windows':'linux'}.${process.platform==='win32'?'zip':'tar.gz'}`);
      } else throw new Error('release assets must be regular files');
    }
    if(!names.size)throw new Error('release builder produced no assets');
    fs.rmSync(root,{recursive:true,force:true});fs.cpSync(out,root,{recursive:true});
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
