import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {capture, run} from '../lib.mjs';
import {tool} from '../tools.mjs';
import {goEnvironment} from './environment.mjs';
import {goParts, goReleaserBuilds, goReleaserConfig, unreleasedCommands} from './goreleaser.mjs';

// A DLL cgo builds links through MinGW's gcc, which can leave it importing a MinGW runtime
// DLL (libwinpthread-1.dll, libgcc_s_seh-1.dll). Nothing ships that DLL beside it, so the
// process loading it fails; fzt-picker's frontend DLL loads into every app that opens a
// file dialog. The imports are objdump -p's "DLL Name:" lines (its whole dump of a Go DLL runs
// to megabytes).
export function mingwRuntimeImports(objdump) {
  const names=[...objdump.matchAll(/DLL Name: (\S+)/g)].map(m=>m[1]);
  if (!names.length) throw new Error('objdump listed no imports');
  return names.filter(name=>/^lib.*\.dll$/i.test(name));
}
// Whether a built file carries the release's VERSION. The linker ignores an -X naming a
// variable that doesn't exist, and a build without -trimpath records its -ldflags text in the
// binary, so that text is taken out before looking.
export function stamped(bytes, version) {
  const escaped=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return bytes.toString('latin1').replace(new RegExp(`-X[=\\s]+[^\\s="]+=${escaped}`,'g'),'').includes(version);
}
// GoReleaser builds this job's builds from .goreleaser.yaml. It wants its output folder empty
// and dist/ may already hold staged dependencies, so it writes to a folder of its own, and the
// programs and DLLs it lists in artifacts.json move to dist/ (the DLLs' C headers stay behind).
export async function buildGo(part=process.env.RELEASE_PART || 'go') {
  goEnvironment();
  const builds=goReleaserBuilds(),missing=unreleasedCommands(builds);
  if (missing.length) throw new Error(`${goReleaserConfig} builds no program from ${missing.join(', ')}`);
  const selected=goParts(builds).find(p=>p.part===part);
  if (!selected) throw new Error(`${goReleaserConfig} has no builds for the ${part} release job`);
  fs.mkdirSync('dist',{recursive:true});
  const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'goreleaser-'));
  try {
    const config=YAML.parseDocument(fs.readFileSync(goReleaserConfig,'utf8'),{merge:true});
    config.set('dist',path.join(temp,'dist'));
    fs.writeFileSync(path.join(temp,'goreleaser.yaml'),String(config));
    run(await tool('goreleaser'),['build','--snapshot','--clean','--parallelism','1','--config',path.join(temp,'goreleaser.yaml'),...selected.ids.flatMap(id=>['--id',id])]);
    for (const artifact of JSON.parse(fs.readFileSync(path.join(temp,'dist','artifacts.json'),'utf8'))) {
      if (!['Binary','C Shared Library'].includes(artifact.type)) continue;
      const asset=path.basename(artifact.path);
      if (fs.existsSync(`dist/${asset}`)) throw new Error(`duplicate Go release asset: ${asset}`);
      fs.copyFileSync(artifact.path,`dist/${asset}`);
      if (process.env.VERSION && !stamped(fs.readFileSync(`dist/${asset}`),process.env.VERSION)) throw new Error(`${asset} doesn't carry ${process.env.VERSION}: ${goReleaserConfig}'s ldflags for it stamp VERSION into no variable that exists (-X ...version={{ .Env.VERSION }})`);
      if (artifact.type==='C Shared Library') {
        const runtime=mingwRuntimeImports(capture('objdump',['-p',`dist/${asset}`],{maxBuffer:1<<28}));
        if (runtime.length) throw new Error(`${asset} needs ${runtime.join(', ')}, which nothing ships beside it`);
      }
      // A js/wasm binary runs only beside the wasm_exec.js of the Go that built it.
      if (artifact.goos==='js' && !fs.existsSync('dist/wasm_exec.js')) {
        fs.copyFileSync(path.join(capture('go',['env','GOROOT']),'lib','wasm','wasm_exec.js'),'dist/wasm_exec.js');
      }
    }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/go/build.mjs')) await buildGo();
