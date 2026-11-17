import {config} from '../config.mjs';
import {output} from '../lib.mjs';
export function releasePlan(cfg=config()) {
  const release=cfg.release || {};
  // A Go library's release is its tag and source (release.module): nothing is built.
  if(release.module)return {matrix:{include:[]},local:false,external:[],metadata:{checksumFiles:[],checksumManifest:'',manifest:''},homeSync:false,image:''};
  const kinds=release.toolchains || [];
  if(kinds.includes('rust') && release.rustTargets?.length===0)throw new Error('release.rustTargets must be nonempty when Rust is declared');
  if ((!kinds.length && !release.external?.length) || kinds.includes('assets')) throw new Error('release.toolchains must declare the builders, not a cross-workflow assets placeholder');
  const include=[];
  for (const kind of kinds) {
    if (kind==='rust') {
      for (const part of release.rustTargets || [{target:'x86_64-unknown-linux-gnu'}]) include.push({id:`rust-${part.target}`,toolchain:kind,target:part.target,features:(part.features || cfg.rust?.features || []).join(','),noDefault:part.noDefaultFeatures ?? cfg.rust?.noDefaultFeatures ?? false,runner:part.target.endsWith('windows-msvc') ? 'windows-latest' : 'ubuntu-latest'});
    } else if(kind==='go') {
      const targets=release.goTargets || [];
      if(!targets.length || targets.some(t=>t.buildmode!=='c-shared'))include.push({id:'go',toolchain:kind,target:'',features:'',noDefault:false,runner:'ubuntu-latest'});
      for(const t of targets.filter(t=>t.buildmode==='c-shared'))include.push({id:`go-${t.goos}-${t.goarch}-c-shared`,toolchain:kind,target:`${t.goos}-${t.goarch}-c-shared`,features:'',noDefault:false,runner:'windows-latest'});
    } else include.push({id:kind,toolchain:kind,target:'',features:'',noDefault:false,runner:cfg[kind]?.buildPlatform || 'ubuntu-latest'});
  }
  const local=include.length>0;
  if(!local)for(const part of release.external)include.push({id:part.id,toolchain:'external',target:part.id,features:'',noDefault:false,runner:'ubuntu-latest'});
  return {matrix:{include},local,external:(release.external || []).map(part=>({...part,assets:[...new Set(part.assets.flatMap(name=>{const value=process.env.VERSION?name.replaceAll('{tag}',process.env.VERSION).replaceAll('{version}',process.env.VERSION.replace(/^v/,'')):name;return value.endsWith('.zip')?[value,`${value}.signature.json`]:[value];}))]})),metadata:{checksumFiles:release.checksumFiles || [],checksumManifest:release.checksumManifest || '',manifest:release.manifest || ''},homeSync:release.homeSync === true,image:release.image || ''};
}
if (process.argv[1]?.endsWith('/release/plan.mjs') || process.argv[1]?.endsWith('\\release\\plan.mjs')) {
  if (process.env.CALLBACK_TAG && (!/^[0-9a-f]{40,64}$/.test(process.env.CALLBACK_SOURCE || '') || !process.env.COMPLETED_PART)) throw new Error('callback needs the reserved source SHA and completed part');
  output('matrix',JSON.stringify(releasePlan().matrix));
  output('has-local',releasePlan().local);
}
