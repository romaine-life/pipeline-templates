import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {run} from '../lib.mjs';
import {config} from '../config.mjs';
import {zipDirectory} from './zip.mjs';

function substitute(pattern,name) {
  const pieces=pattern.split('*');
  if(pieces.length===1)return pattern===name?'':null;
  return name.startsWith(pieces[0]) && name.endsWith(pieces[1]) && name.length>=pieces[0].length+pieces[1].length?name.slice(pieces[0].length,name.length-pieces[1].length):null;
}
export function assetName(name,{kind,part=kind,target='',cfg=config()}={}) {
  let selector=part;
  if(kind==='go')for(const item of cfg.release?.goTargets || [])if(name.endsWith(`-${item.goos}-${item.goarch}${item.buildmode==='c-shared'?'.dll':item.goos==='windows'?'.exe':''}`))selector=`go-${item.goos}-${item.goarch}`;
  const maps={...(cfg.release?.assetNames?.[part] || {}),...(cfg.release?.assetNames?.[selector] || {})};
  const expand=value=>value.replaceAll('{tag}',process.env.VERSION || '').replaceAll('{version}',(process.env.VERSION || '').replace(/^v/,''));
  let standard=null;
  if(kind==='rust' && target) {
    const triple=target.match(/^(x86_64|aarch64)-(?:pc-windows-msvc|unknown-linux-gnu)$/);
    if(triple && (name.endsWith(`-${target}${target.includes('windows')?'.exe':''}`) || name.endsWith(`-${target}.dll`) || name.endsWith(`-${target}.so`)))standard=name.replace(`-${target}`,`-${target.includes('windows')?'windows':'linux'}-${triple[1]==='x86_64'?'amd64':'arm64'}`);
  }
  const matches=Object.entries(maps).map(([pattern,value])=>({value,capture:substitute(expand(pattern),name) ?? (standard?substitute(expand(pattern),standard):null)})).filter(match=>match.capture!==null);
  if(matches.length>1)throw new Error(`ambiguous release asset rename: ${name}`);
  let result=matches.length?matches[0].value.replace('*',matches[0].capture):standard;
  if(result===null)return null;
  result=result.replaceAll('{tag}',process.env.VERSION || '').replaceAll('{version}',(process.env.VERSION || '').replace(/^v/,''));
  if(!/^[\w.+-]+$/.test(result) || result.startsWith('ci-release-'))throw new Error(`invalid published asset name: ${result}`);
  return result;
}
export function packageAssets({kind=process.env.RELEASE_TOOLCHAIN,part=process.env.RELEASE_PART || kind,target=process.env.RELEASE_TARGET || '',cfg=config()}={}) {
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
      const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/'),rename=assetName(relative,{kind,part,target,cfg});
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
