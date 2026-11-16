import fs from 'node:fs';
import path from 'node:path';
import {capture,hash,safePath} from './lib.mjs';
import {dockerSources} from './dependencies.mjs';
import {matches} from './input-patterns.mjs';

export function imageLayout(section={}) {
  const context=safePath(section.context || '.'),dockerfile=safePath(section.dockerfile || 'Dockerfile');
  return {context,dockerfile,ignore:[path.posix.join(context,'.dockerignore'),`${dockerfile}.dockerignore`]};
}
export function imageInputs(cfg,kind,read=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):null) {
  const layout=imageLayout(cfg[kind]),text=read(layout.dockerfile);
  if(text===null)throw new Error(`missing image Dockerfile: ${layout.dockerfile}`);
  return [...new Set([layout.dockerfile,...layout.ignore,...dockerSources(text).map(input=>path.posix.join(layout.context,input)),...(cfg.inputs?.[kind==='cluster'?'cluster-service.image':'web-app.image'] || [])])].sort();
}
export function imageFingerprint(cfg,kind,ref='HEAD') {
  const entries=capture('git',['ls-tree','-rz','--full-tree',ref]).split('\0').filter(Boolean).map(line=>{const split=line.indexOf('\t');return {path:line.slice(split+1),object:line.slice(0,split)};});
  const read=file=>entries.some(e=>e.path===file)?capture('git',['show',`${ref}:${file}`]):null;
  const patterns=imageInputs(cfg,kind,read),layout=imageLayout(cfg[kind]);
  return hash(JSON.stringify({version:1,layout,patterns,files:entries.filter(entry=>patterns.some(pattern=>matches(entry.path,pattern)))}));
}
export function pinnedImage(section) {
  if(!section.pinFile)throw new Error('joined image reuse requires pinFile');
  const escaped=section.image.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pins=[...new Set(fs.readFileSync(section.pinFile,'utf8').match(new RegExp(`${escaped}:[\\w.+-]+@sha256:[0-9a-f]{64}`,'g')) || [])];
  if(pins.length!==1)throw new Error('pinFile must contain one distinct image pin');
  return pins[0];
}
