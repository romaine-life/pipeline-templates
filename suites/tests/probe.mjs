import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const log = value => fs.appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(value)}\n`);
child.spawnSync = (command, args, options) => {
  log({command, args, goos:options.env?.GOOS,goarch:options.env?.GOARCH,input: options.input ? '<stdin>' : undefined});
  if (process.env.PROBE_FAIL === command) return {status: 9, stdout: ''};
  let stdout = '';
  if (command === 'rustc') stdout = 'rustc 1.100.0 (abc 2026-01-01)';
  if (command === 'python') stdout = 'Python 3.12.10';
  if (command === 'dotnet' && args[0]==='--version') stdout = '9.0.321';
  if (command === 'git' && args[0] === 'ls-files') stdout = args.includes('--eol')
    ? ['README.md','main.go','config.json'].map(f => `i/lf    w/${f === 'main.go' ? process.env.PROBE_GO_EOL || 'crlf' : 'lf'}  attr/                 \t${f}`).join('\0') + '\0'
    : 'README.md\0main.go\0config.json\0';
  if (command === 'git' && args.includes('--name-only')) stdout = process.env.PROBE_DIFF || '';
  if (command === 'git' && args[0] === 'rev-parse') stdout = 'a'.repeat(40);
  if (command === 'go' && args[0] === 'list') stdout = 'example.com/probe/cmd/probe';
  if (command === 'cargo' && args[0] === 'build') {
    fs.mkdirSync(path.join(process.env.CARGO_TARGET_DIR,'release'),{recursive:true});
    fs.writeFileSync(path.join(process.env.CARGO_TARGET_DIR,'release',`probe${process.platform === 'win32' ? '.exe' : ''}`), 'binary');
  }
  if (command === 'cargo' && args[0] === 'metadata') stdout = JSON.stringify({workspace_members:['probe'],packages:[{id:'probe',targets:[{name:'probe',kind:['bin']}]}]});
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
  if (u.includes('/labels?')) body = [{id:1,name:'queue'}];
  if (u.includes('/pulls?')) body = process.env.PROBE_OPEN ? [{number:6,body:'Previous take-up',html_url:'https://forgejo.romaine.life/test/probe/pulls/6',head:{ref:'deps/ci-suite-0',sha:'a'.repeat(40)}}] : [];
  if (u.includes('/contents/')) {
    const file=new URL(u).pathname.split('/').at(-1);
    body={content:Buffer.from(process.env.PROBE_OPEN==='identical' ? fs.readFileSync(file) : 'old dependency').toString('base64')};
  }
  if (u.includes('/releases/latest')) return new Response('{}',{status:404});
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
};
