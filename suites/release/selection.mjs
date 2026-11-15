import path from 'node:path';
import {assetName} from './assets.mjs';
export function parts(kind,cfg) {
  if(kind==='rust')return (cfg.release?.rustTargets || [{target:'x86_64-unknown-linux-gnu'}]).map(item=>({part:`rust-${item.target}`,target:item.target,aliases:[item.target]}));
  if(kind==='go') {
    const targets=cfg.release?.goTargets || [],result=[];
    if(!targets.length || targets.some(t=>t.buildmode!=='c-shared'))result.push({part:'go',target:'',aliases:targets.filter(t=>t.buildmode!=='c-shared').map(t=>`${t.goos}-${t.goarch}`)});
    for(const t of targets.filter(t=>t.buildmode==='c-shared'))result.push({part:`go-${t.goos}-${t.goarch}-c-shared`,target:`${t.goos}-${t.goarch}-c-shared`,aliases:[`${t.goos}-${t.goarch}-c-shared`]});
    return result;
  }
  return [{part:kind,target:'',aliases:[process.platform]}];
}
export function selected(item,kind,cfg,target=process.env.RELEASE_TARGET || '') {
  const owner=item.toolchain || cfg.release?.toolchains?.[0] || kind;if(owner!==kind)return false;
  const candidates=parts(kind,cfg),current=target || (kind==='rust'?candidates[0].target:'');
  const part=candidates.find(p=>p.target===current);if(!part)return false;
  if(item.targets)return part.aliases.some(t=>item.targets.includes(t));
  if(item.destination && !item.destination.startsWith('dist/'))return true;
  return part===candidates[0];
}
export function validateDependencyOwnership(cfg) {
  for(const dependency of cfg.release?.dependencies || []) {
    const kind=dependency.toolchain || cfg.release?.toolchains?.[0];if(!kind)continue;
    const emitted=new Set(),candidates=parts(kind,cfg).filter(part=>selected(dependency,kind,cfg,part.target));
    if(dependency.targets && !candidates.length)throw new Error('dependency targets match no declared release part');
    if(!dependency.destination.startsWith('dist/'))continue;
    const file=dependency.destination.slice('dist/'.length);
    for(const part of candidates) {
      if((cfg.release?.archives || []).some(archive=>selected(archive,kind,cfg,part.target) && archive.sources.includes(dependency.destination)))continue;
      const name=assetName(file,{kind,...part,cfg}) || path.basename(file);
      if(emitted.has(name))throw new Error(`dependency ${name} would be published by several targets; select one target, distinct assetNames, or consume it in per-target archives`);
      emitted.add(name);
    }
  }
}
