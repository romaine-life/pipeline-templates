import {config} from '../config.mjs';
import {output} from '../lib.mjs';
import {goParts} from '../go/goreleaser.mjs';
import {rustBuilds} from '../topics.mjs';
// A CMake, .NET or Python release builds where its tests run: on Windows when they run on
// Windows alone (its -test-windows topic without -test-linux), else on Linux.
export const buildRunner=(cfg,kind)=>{const platforms=cfg[kind]?.platforms || [];return platforms.length===1 && platforms[0]==='windows-latest' ? 'windows-latest' : 'ubuntu-latest';};
export function releasePlan(cfg=config(),goBuilds) {
  const release=cfg.release || {};
  // A Go library's release is its tag and source (release-module): nothing is built.
  if(release.module)return {matrix:{include:[]},local:false,external:[],homeSync:false,image:''};
  const kinds=release.toolchains || [];
  if(kinds.includes('rust') && release.rustTargets?.length===0)throw new Error('release.rustTargets must be nonempty when Rust is declared');
  // A release that builds nothing (mGBA's) publishes what it downloads (release/dependencies.json)
  // and its release/assets/files/: one part, on Linux.
  const files=!kinds.length && !release.external?.length && release.dependencies?.length>0;
  if ((!kinds.length && !release.external?.length && !files) || kinds.includes('assets')) throw new Error('release.toolchains must declare the builders, not a cross-workflow assets placeholder');
  const include=files ? [{id:'files',toolchain:'files',target:'',features:'',noDefault:false,runner:'ubuntu-latest'}] : [];
  for (const kind of kinds) {
    if (kind==='rust') {
      // installTarget is the target whose standard library rustup installs: a GBA ROM builds its
      // own (rust/gba.mjs), and rustup ships none for it.
      for (const part of release.rustTargets || [{target:'x86_64-unknown-linux-gnu'}]) include.push({id:`rust-${part.target}`,toolchain:kind,target:part.target,installTarget:part.target===rustBuilds.gba ? '' : part.target,features:(part.features || []).join(','),noDefault:part.noDefaultFeatures ?? false,runner:part.target.endsWith('windows-msvc') ? 'windows-latest' : 'ubuntu-latest'});
    } else if(kind==='go') {
      for(const part of goParts(goBuilds))include.push({id:part.part,toolchain:kind,target:part.target,features:'',noDefault:false,runner:part.runner});
    } else include.push({id:kind,toolchain:kind,target:'',features:'',noDefault:false,runner:buildRunner(cfg,kind)});
  }
  const local=include.length>0;
  if(!local)for(const part of release.external)include.push({id:part.id,toolchain:'external',target:part.id,features:'',noDefault:false,runner:'ubuntu-latest'});
  return {matrix:{include},local,external:(release.external || []).map(part=>({id:part.id,workflow:part.workflow})),homeSync:release.homeSync === true,image:release.image || ''};
}
// Forgejo never creates a job whose matrix has no entries, and the jobs that need it then
// wait forever (fzt's first module PR). An empty plan is sent as one placeholder entry, so
// build and check-build exist (on a runner, which runs-on reads from the entry) and their
// has-local condition skips them.
export function matrixOutput(matrix) {
  return JSON.stringify(matrix.include.length ? matrix : {include: [{toolchain: 'none', runner: 'ubuntu-latest'}]});
}
if (process.argv[1]?.endsWith('/release/plan.mjs') || process.argv[1]?.endsWith('\\release\\plan.mjs')) {
  if (process.env.CALLBACK_TAG && (!/^[0-9a-f]{40,64}$/.test(process.env.CALLBACK_SOURCE || '') || !process.env.COMPLETED_PART)) throw new Error('callback needs the reserved source SHA and completed part');
  output('matrix',matrixOutput(releasePlan().matrix));
  output('has-local',releasePlan().local);
}
