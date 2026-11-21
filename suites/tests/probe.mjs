import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
const log = value => fs.appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(value)}\n`);
child.spawnSync = (command, args, options) => {
  log({command, args, cwd:options.cwd, goos:options.env?.GOOS,goarch:options.env?.GOARCH,input: options.input ? '<stdin>' : undefined});
  if (process.env.PROBE_FAIL === command) return {status: 9, stdout: ''};
  // The registry refuses the first docker login (the job's own token), and takes the next.
  if (process.env.PROBE_REFUSE_LOGIN && command === 'docker' && args[0] === 'login' && !globalThis.refusedLogin) {
    globalThis.refusedLogin = true;
    return {status: 1, stdout: ''};
  }
  let stdout = '';
  if (command === 'rustc') stdout = 'rustc 1.100.0 (abc 2026-01-01)';
  if (command === 'python') stdout = 'Python 3.12.10';
  if (command === 'dotnet' && args[0]==='--version') stdout = '9.0.321';
  if (command === 'git' && args[0] === 'ls-files') stdout = args.length === 2 && process.env.PROBE_TRACKED ? process.env.PROBE_TRACKED.split(',').join('\0') + '\0' : args.includes('--eol')
    ? ['README.md','main.go','config.json'].map(f => `i/lf    w/${f === 'main.go' ? process.env.PROBE_GO_EOL || 'crlf' : 'lf'}  attr/                 \t${f}`).join('\0') + '\0'
    : 'README.md\0main.go\0config.json\0';
  if (command === 'git' && args.includes('--name-only')) stdout = process.env.PROBE_DIFF || '';
  if (command === 'git' && args[0] === 'rev-parse') stdout = 'a'.repeat(40);
  if (command === 'go' && args[0] === 'list') stdout = process.env.PROBE_GO_LIST ?? 'example.com/probe/cmd/probe';
  // The packages each listed program links (PROBE_GO_DEPS), and the declaration go doc finds
  // for a stamped variable (PROBE_GO_DOC; empty, it finds none).
  if (command === 'go' && args[0] === 'list' && args[1] === '-f') stdout = args.slice(3).map(() => process.env.PROBE_GO_DEPS ?? 'example.com/probe/internal/buildinfo').join('\n');
  if (command === 'go' && args[0] === 'doc') {
    if (process.env.PROBE_GO_DOC === '') return {status: 1, stdout: ''};
    stdout = process.env.PROBE_GO_DOC ?? 'var version string';
  }
  if (command === 'go' && args[0] === 'env' && args[1] === 'GOROOT') stdout = process.env.PROBE_GOROOT || '';
  // GoReleaser writes each --id's artifacts (PROBE_GORELEASER, else one Linux program per id)
  // into the dist its --config names, and lists them in artifacts.json as it does.
  if (command === 'goreleaser' && args[0] === 'build') {
    const dist = YAML.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8')).dist;
    const ids = args.flatMap((a, i) => a === '--id' ? [args[i + 1]] : []);
    const artifacts = (process.env.PROBE_GORELEASER ? JSON.parse(process.env.PROBE_GORELEASER) : ids.map(id => ({name: id, type: 'Binary', goos: 'linux'})))
      .map(a => ({...a, path: path.join(dist, a.name)}));
    fs.mkdirSync(dist, {recursive: true});
    for (const a of artifacts) fs.writeFileSync(a.path, 'binary');
    fs.writeFileSync(path.join(dist, 'artifacts.json'), JSON.stringify([{name: 'metadata.json', path: path.join(dist, 'metadata.json'), type: 'Metadata'}, ...artifacts]));
  }
  if (command === 'objdump') stdout = '\tDLL Name: KERNEL32.dll\n';
  if (command === 'cargo' && args[0] === 'build') {
    // A GBA build (--target thumbv4t-none-eabi) leaves its program, an ELF with no extension,
    // under its target; the host build under release/.
    const gba = args.includes('thumbv4t-none-eabi'), directory = path.join(process.env.CARGO_TARGET_DIR, ...(gba ? ['thumbv4t-none-eabi'] : []), 'release');
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,`${process.env.PROBE_CARGO_BIN || 'probe'}${process.platform === 'win32' && !gba ? '.exe' : ''}`), 'binary');
  }
  if (command === 'cargo' && args[0] === 'metadata') {
    const name = process.env.PROBE_CARGO_BIN || 'probe';
    stdout = JSON.stringify({workspace_members:[name],packages:[{id:name,name,targets:[{name,kind:['bin']}]}]});
  }
  // agb-gbafix writes the ROM its -o names.
  if (path.basename(command).startsWith('agb-gbafix')) fs.writeFileSync(path.resolve(options.cwd || '.', args[args.indexOf('-o') + 1]), 'rom');
  if (command === 'docker' && args[0] === 'image') stdout = JSON.stringify([`${process.env.PROBE_IMAGE || 'forgejo.romaine.life/test/probe'}@sha256:${'b'.repeat(64)}`]);
  if (command === 'kustomize' || command === 'helm') stdout = `kind: Pod\nspec:\n  containers:\n    - image: forgejo.romaine.life/test/probe@sha256:${'b'.repeat(64)}\n`;
  return {status:0,stdout};
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options = {}) => {
  log({url:String(url),method:options.method || 'GET',body:typeof options.body==='string' && options.headers?.['Content-Type']==='application/json'?JSON.parse(options.body):undefined});
  const u = String(url);
  let body = {};
  if (u.includes('oidc')) body = {value:'jwt'};
  if (u.includes('/auth/forgejo/login')) body = {auth:{client_token:'bao'}};
  if (u.includes('/secret/data/')) body = {data:{data:{'registry-token':'registry'}}};
  if (u.endsWith('/pulls')) body = {number:7,html_url:'https://forgejo.romaine.life/test/probe/pulls/7'};
  if (u.includes('/commits/') && u.endsWith('/pull')) body = process.env.PROBE_MERGED ? {number:3,title:'Merged',html_url:'https://forgejo.romaine.life/test/probe/pulls/3',body:process.env.PROBE_MERGED} : {};
  if (u.includes('/labels?')) body = [{id:1,name:'queue'}];
  if (u.includes('/pulls?')) body = process.env.PROBE_OPEN_PIN ? [{number:5,body:'Previous pin',html_url:'https://forgejo.romaine.life/test/probe/pulls/5',head:{ref:`ci-pin/${process.env.PROBE_OPEN_PIN}`,sha:'a'.repeat(40)}}]
    : process.env.PROBE_OPEN ? [{number:6,body:'Previous take-up',html_url:'https://forgejo.romaine.life/test/probe/pulls/6',head:{ref:'deps/0',sha:'a'.repeat(40)}}] : [];
  if (u.includes('/contents/')) {
    const file=new URL(u).pathname.split('/').at(-1);
    body={content:Buffer.from(process.env.PROBE_OPEN==='identical' ? fs.readFileSync(file) : 'old dependency').toString('base64')};
  }
  if (u.includes('/releases/latest')) return new Response('{}',{status:404});
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
};
