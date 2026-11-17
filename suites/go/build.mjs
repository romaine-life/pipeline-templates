import fs from 'node:fs';
import path from 'node:path';
import {capture, kept, run} from '../lib.mjs';
import {config} from '../config.mjs';
import {goEnvironment} from './environment.mjs';

export function goBuilds(cfg) {
  const targets=cfg.release?.goTargets || [{goos:process.env.GOOS || (process.platform==='win32' ? 'windows' : process.platform),goarch:process.env.GOARCH || 'amd64'}];
  const selected=process.env.RELEASE_TARGET;
  return selected ? targets.filter(t=>`${t.goos}-${t.goarch}-${t.buildmode || 'exe'}`===selected) : process.env.RELEASE_TOOLCHAIN==='go' ? targets.filter(t=>t.buildmode!=='c-shared') : targets;
}
export function buildGo(cfg=config()) {
  goEnvironment();
  fs.mkdirSync('dist',{recursive:true});
  const gui=new Set(cfg.release?.windowsGui || []);
  for (const target of goBuilds(cfg)) {
    const env={...process.env,GOOS:target.goos,GOARCH:target.goarch,CGO_ENABLED:target.buildmode==='c-shared'?'1':'0'};
    const packages=capture('go',['list','-f','{{if eq .Name "main"}}{{.ImportPath}}{{end}}',...(target.packages || ['./cmd/...'])],{env}).split(/\r?\n/).filter(Boolean);
    if (!packages.length) throw new Error('Go executables belong under cmd/<name>/');
    for (const pkg of packages) {
      const flags=['-s','-w'];
      for (const stamp of cfg.release?.goStampPackages || ['main']) {
        for (const [key,value] of Object.entries({version:process.env.VERSION,buildRepo:process.env.GITHUB_REPOSITORY,buildServer:process.env.GITHUB_SERVER_URL,buildTime:new Date().toISOString()})) if (value) flags.push('-X',`${stamp}.${key}=${value}`);
      }
      if (target.goos==='windows' && target.buildmode!=='c-shared' && (gui.has(pkg) || gui.has(`./cmd/${path.basename(pkg)}`))) flags.push('-H','windowsgui');
      const asset=`${path.basename(pkg)}-${target.goos}-${target.goarch}${target.buildmode==='c-shared'?'.dll':target.goos==='windows'?'.exe':''}`;
      if (fs.existsSync(`dist/${asset}`)) throw new Error(`duplicate Go release asset: ${asset}`);
      const manifest=path.resolve('cmd',path.basename(pkg),`${path.basename(pkg)}.manifest`);
      const resource=path.join(path.dirname(manifest),`zz_ci_resource_windows_${target.goarch}.syso`);
      const embed=target.goos==='windows' && fs.existsSync(manifest);
      if (embed && fs.existsSync(resource)) throw new Error(`remove the stale generated resource: ${resource}`);
      try {
        if (embed) {
          const native={GOOS:process.platform==='win32' ? 'windows' : process.platform,GOARCH:process.arch==='x64' ? 'amd64' : process.arch};
          const bin=kept(`go-tools/rsrc-0.10.2/${capture('go',['env','GOVERSION'])}`);
          const rsrc=path.join(bin,`rsrc${process.platform==='win32' ? '.exe' : ''}`);
          if (!fs.existsSync(rsrc)) run('go',['install','-p','4','github.com/akavel/rsrc@v0.10.2'],{env:{...native,GOBIN:bin}});
          run(rsrc,['-manifest',manifest,'-arch',target.goarch,'-o',resource]);
        }
        run('go',['build','-p','4',...(target.buildmode?['-buildmode',target.buildmode]:[]),'-trimpath','-ldflags',flags.join(' '),'-o',`dist/${asset}`,pkg],{env});
      if(target.buildmode==='c-shared'){const header=`dist/${asset.replace(/\.dll$/,'.h')}`;if(fs.existsSync(header))fs.unlinkSync(header);}
      } finally {if (embed && fs.existsSync(resource)) fs.unlinkSync(resource);}
    }
    // A js/wasm binary runs only beside the wasm_exec.js of the Go that built it.
    if (target.goos==='js' && target.goarch==='wasm' && !fs.existsSync('dist/wasm_exec.js')) {
      fs.copyFileSync(path.join(capture('go',['env','GOROOT']),'lib','wasm','wasm_exec.js'),'dist/wasm_exec.js');
    }
  }
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/go/build.mjs')) buildGo();
