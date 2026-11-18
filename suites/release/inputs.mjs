import fs from 'node:fs';
import TOML from '@iarna/toml';
import {capture} from '../lib.mjs';
import {matches,relevant} from '../input-patterns.mjs';
import {embedded,imageInputs} from '../dependencies.mjs';
import {pythonProjects} from '../conventions.mjs';

const canonical=value=>JSON.stringify(value,(_,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
export function settings(cfg) {
  const kinds=cfg.release?.toolchains || [],result={release:cfg.release};
  if(kinds.includes('rust'))result.rust={features:cfg.rust?.features,noDefaultFeatures:cfg.rust?.noDefaultFeatures};
  if(kinds.includes('npm'))result.web={packages:cfg.web?.packages};
  for(const kind of ['cmake','dotnet','python'])if(kinds.includes(kind))result[kind]={buildPlatform:cfg[kind]?.buildPlatform,...(kind==='dotnet'?{sdk:cfg.dotnet?.sdk}:{})};
  if(cfg.release?.image)result.image=cfg[cfg.release.image];
  return result;
}
const locks={go:['**/go.mod','**/go.sum','go.work','go.work.sum'],rust:['**/Cargo.lock','rust-toolchain*','.cargo/**','**/.cargo/**'],dotnet:['**/packages.lock.json','global.json','NuGet.Config','**/*.*proj','**/*.props','**/*.targets'],cmake:['vcpkg.json','vcpkg-configuration.json','CMakePresets.json','**/CMakeLists.txt','**/*.cmake']};
export function packagingInputs(cfg,read) {
  const patterns=[...(cfg.release?.toolchains || []).flatMap(kind=>locks[kind] || []),...(cfg.release?.dependencies || []).flatMap(item=>item.lock ? [item.lock] : []),...(cfg.web?.dependencies?.length ? ['dependencies.lock'] : []),...(cfg.release?.archives || []).flatMap(item=>item.sources)],metadata=[];
  if(cfg.release?.toolchains?.includes('python'))for(const dir of pythonProjects())for(const file of ['uv.lock','pyproject.toml','setup.py','setup.cfg','.python-version'])patterns.push(dir==='.' ? file : `${dir}/${file}`);
  if(cfg.release?.toolchains?.includes('npm'))for(const dir of cfg.web?.packages || ['.']) {
    const prefix=dir==='.' ? '' : `${dir}/`;
    patterns.push(...['package-lock.json','npm-shrinkwrap.json','.npmrc','vite.config.*','webpack.config.*','tsconfig*.json'].map(file=>prefix+file));
    metadata.push({path:prefix+'package.json',kind:'npm'});
  }
  if(cfg.release?.image)patterns.push(...imageInputs(cfg[cfg.release.image],read));
  if(cfg.release?.toolchains?.includes('rust'))metadata.push({path:'**/Cargo.toml',kind:'cargo'});
  return {patterns,metadata};
}
export function packagingMetadata(kind,text) {
  const value=text ? (kind==='cargo' ? TOML.parse(text) : JSON.parse(text)) : {};
  return kind==='cargo' ? {features:value.features,profile:value.profile} : {name:value.name,version:value.version,build:value.scripts?.build,prebuild:value.scripts?.prebuild,postbuild:value.scripts?.postbuild};
}
export function packagingChanged(files,cfg,readBefore,readAfter=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):null) {
  const specification=packagingInputs(cfg);
  if(relevant(files,'release.package',specification.patterns))return true;
  for(const selector of specification.metadata)for(const file of files.filter(file=>matches(file,selector.path))) {
    if(canonical(packagingMetadata(selector.kind,readBefore(file)))!==canonical(packagingMetadata(selector.kind,readAfter(file))))return true;
  }
  return false;
}
export function packagingScope(files,cfg,base=process.env.BASE) {
  const mergeBase=capture('git',['merge-base',base,'HEAD']);
  const existing=new Set(capture('git',['ls-tree','-r','--name-only','-z',mergeBase]).split('\0'));
  return packagingChanged(files,cfg,file=>existing.has(file) ? capture('git',['show',`${mergeBase}:${file}`]) : null);
}
// What a merge's release reads beyond its patterns, inside the ignored files too: what its code
// embeds, its joined image's inputs, its pinned dependencies' locks and the sources its archives
// ship (tuimail's carry its README and LICENSE).
export function releaseInputs(cfg,read) {
  return [...(cfg.release?.toolchains || []).flatMap(kind=>embedded()[kind] || []),...(cfg.release?.image ? imageInputs(cfg[cfg.release.image],read) : []),...(cfg.release?.dependencies || []).flatMap(item=>item.lock ? [item.lock] : []),...(cfg.web?.dependencies?.length ? ['dependencies.lock'] : []),...(cfg.release?.archives || []).flatMap(item=>item.sources)];
}
