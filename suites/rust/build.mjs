import fs from 'node:fs';
import path from 'node:path';
import {capture, kept, run} from '../lib.mjs';
import {tool} from '../tools.mjs';
import {config} from '../config.mjs';
import {cargoCache} from './cache.mjs';
import {rustEnvironment} from './environment.mjs';
import {buildRoms, gbaTarget} from './gba.mjs';
rustEnvironment();
cargoCache(`release-${process.platform}`);
const target=process.env.RELEASE_TARGET;
const features=(process.env.RELEASE_FEATURES || '').split(',').filter(Boolean);
const noDefault=process.env.RELEASE_NO_DEFAULT==='true';
const part=(config().release?.rustTargets || []).find(item=>item.target===target);
// A GBA ROM builds in its agb crate's own folder and becomes a ROM there (gba.mjs).
if(target===gbaTarget) {
  buildRoms({part,features,noDefault});
  process.exit(0);
}
let build='build',buildTarget=target;
if(part?.glibc) {
  // cargo-zigbuild with zig as C toolchain and linker: it links another architecture, and holds
  // the binary to the declared glibc (target.2.35), which a build on the runner's own glibc can't.
  const zig=await tool('zig'),zigbuild=await tool('cargoZigbuild');
  process.env.PATH=[path.dirname(zig),path.dirname(zigbuild),process.env.PATH].join(path.delimiter);
  process.env.CARGO_ZIGBUILD_CACHE_DIR=kept('cargo-zigbuild');
  build='zigbuild';buildTarget=`${target}.${part.glibc}`;
}
if(target==='aarch64-pc-windows-msvc' && !process.env.CC_aarch64_pc_windows_msvc) {
  // ring compiles its C with clang on Windows ARM64; home-sync installs LLVM on the Windows runner.
  const clang=path.join(process.env.ProgramFiles || 'C:\\Program Files','LLVM','bin','clang.exe');
  if(!fs.existsSync(clang))throw new Error(`Windows ARM64 needs LLVM's clang on the runner, at ${clang}`);
  process.env.CC_aarch64_pc_windows_msvc=clang;
}
run('cargo', [build, '-j', '4', '--locked', '--release', ...(part?.package ? ['-p', part.package] : ['--workspace']), ...(target ? ['--target',buildTarget] : []),
  ...(noDefault ? ['--no-default-features'] : []), ...(features?.length ? ['--features', features.join(',')] : [])]);
const metadata = JSON.parse(capture('cargo', ['metadata', '--no-deps', '--format-version', '1']));
fs.mkdirSync('dist', {recursive: true});
for (const pkg of metadata.packages.filter(p => metadata.workspace_members.includes(p.id) && (!part?.package || p.name === part.package))) {
  for (const output of pkg.targets.filter(t => t.kind.includes('bin') || t.kind.includes('cdylib'))) {
    const platformTarget=process.env.RELEASE_TARGET,windows=platformTarget?platformTarget.includes('windows'):process.platform==='win32';
    const library=output.kind.includes('cdylib'),stem=library?output.name.replaceAll('-','_'):output.name;
    const extension=library?(windows?'.dll':'.so'):(windows?'.exe':'');
    const name=`${library && !windows?'lib':''}${stem}${extension}`;
    const directory=path.join(process.env.CARGO_TARGET_DIR,...(platformTarget?[platformTarget]:[]),'release');
    fs.copyFileSync(path.join(directory,name),path.join('dist',`${library && !windows?'lib':''}${stem}${platformTarget?`-${platformTarget}`:''}${extension}`));
  }
}
