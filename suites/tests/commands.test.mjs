import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {suites} from '../lib.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';

function probe(script, args = [], env = {}, cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'suite-command-'));
  try {
    fleetEntry(({version:1,...cfg}),'test/probe');
    fs.writeFileSync(path.join(root,'README.md'),'# A document\n');
    fs.writeFileSync(path.join(root,'config.json'),'{}');
    fs.writeFileSync(path.join(root,'main.go'),'package main\r\n');
    fs.writeFileSync(path.join(root,'go.mod'),'module example.com/probe\n');
    fs.writeFileSync(path.join(root,'go.sum'),'dependency checksums\n');
    fs.writeFileSync(path.join(root,'.ci-image-pin'),`forgejo.romaine.life/test/probe:v0.1.1@sha256:${'b'.repeat(64)}`);
    fs.mkdirSync(path.join(root,'k8s'));
    fs.writeFileSync(path.join(root,'k8s/deployment.yaml'),`image: forgejo.romaine.life/test/probe:v0.1.0@sha256:${'a'.repeat(64)}`);
    const log = path.join(root,'trace');
    const result = spawnSync(process.execPath,['--import',pathToFileURL(path.join(suites,'tests/probe.mjs')).href,path.join(suites,script),...args],{cwd:root,encoding:'utf8',env:{...process.env,
      CI_CACHE_ROOT:path.join(root,'cache'),CI_CARGO_LOCKED:'1',PROBE_LOG:log,BASE:'a'.repeat(40),GITHUB_EVENT_NAME:'push',DEFAULT_BRANCH:'main',GITHUB_REF:'refs/heads/main',
      GITHUB_REPOSITORY:'test/probe',GITHUB_SERVER_URL:'https://forgejo.romaine.life',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',VERSION:'v0.1.1',TOKEN:'test',PIN_TOKEN:'test',
      ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.invalid/oidc?',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'test',
      CI_TOOL_HELM:'helm',CI_TOOL_KUSTOMIZE:'kustomize',CI_TOOL_KUBECONFORM:'kubeconform',...env}});
    const trace = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return {result,trace};
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('toolchain scripts execute standard commands and propagate failures', () => {
  for (const [script,expected,cfg] of [
    ['go/format.mjs',['git','gofmt'],{}],['go/test.mjs',['go','go','go'],{}],['go/build.mjs',['go','go'],{}],
    ['rust/format.mjs',['cargo'],{}],['rust/test.mjs',['rustc','cargo','cargo'],{}],['rust/build.mjs',['rustc','cargo','cargo'],{}],
    ['web-app/test.mjs',process.platform === 'win32' ? ['npm.cmd','npm.cmd','npm.cmd'] : ['npm','npm','npm'],{}],
    ['powershell/files.mjs',['git'],{}],['docs/validate.mjs',['git','git','git'],{}],
    ['tofu/plan.mjs',['tofu','tofu','tofu','tofu'],{}],['tofu/apply.mjs',['tofu','tofu'],{}],
    ['default/fetches.mjs',[process.platform === 'win32' ? 'python' : 'python3'],{}],
    ['python/test.mjs',['python','uv','uv','uv','uv'],{}],
    ['python/build.mjs',['python','uv'],{}],
    ['dotnet/test.mjs',['dotnet','git','dotnet','dotnet','dotnet'],{}]
  ]) {
    const {result,trace} = probe(script,[],{},cfg);
    assert.equal(result.status,0,`${script}: ${result.stderr}`);
    assert.deepEqual(trace.filter(t=>t.command).map(t=>t.command),expected,script);
  }
  const uv = probe('python/test.mjs').trace.filter(t => t.command === 'uv' && t.args[0] === 'run').map(t => t.args.slice(2).join(' '));
  assert.deepEqual(uv, ["ruff check --config extend-exclude = ['_ci'] .", "ruff format --check --config extend-exclude = ['_ci'] .", 'pytest --ignore=_ci'], 'the suite checkout in _ci/ is not the repository\'s code');
  const gofmt = probe('go/format.mjs').trace.find(t => t.command === 'gofmt');
  assert.match(gofmt.args.at(-1).replaceAll('\\','/'),/gofmt-[^/]+\/main\.go$/,'a CRLF checkout of an LF commit is formatted from an LF copy');
  const committed = probe('go/format.mjs',[],{PROBE_GO_EOL:'lf'}).trace.find(t => t.command === 'gofmt');
  assert.equal(committed.args.at(-1),'main.go','a file is formatted as it is when the checkout matches the commit');
  const {result} = probe('go/test.mjs',[],{PROBE_FAIL:'go'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/go exited 9/);
});
test('PRs cannot apply infrastructure or propose pins', () => {
  for (const script of ['tofu/apply.mjs','cluster-service/pin.mjs']) {
    const {result,trace} = probe(script,[],{GITHUB_EVENT_NAME:'pull_request'});
    assert.notEqual(result.status,0);
    assert.equal(trace.length,0);
  }
});
test('image checks smoke once, publication skips smoke and queues the pin without polling', () => {
  const cfg = {cluster:{image:'forgejo.romaine.life/test/probe',baoRole:'probe-publish',baoSecret:'services/probe-build',pinFile:'k8s/deployment.yaml',workPackage:'https://openproject.home.romaine.life/wp/PIPT-12'}};
  let check = probe('cluster-service/image.mjs',['check'],{},cfg);
  assert.equal(check.result.status,0,check.result.stderr);
  assert.deepEqual(check.trace.filter(t=>t.command).map(t=>t.args[0]),['build','run']);
  const publish = probe('cluster-service/image.mjs',['publish'],{},cfg);
  assert.equal(publish.result.status,0,publish.result.stderr);
  assert.equal(publish.trace.some(t=>t.command==='docker' && t.args[0]==='run'),false);
  assert.equal(publish.trace.some(t=>t.command==='docker' && t.args[0]==='login' && t.input==='<stdin>'),true);
  const pin = probe('cluster-service/pin.mjs',[],{},cfg);
  assert.equal(pin.result.status,0,pin.result.stderr);
  assert.equal(pin.trace.filter(t=>t.url?.endsWith('/pulls')).length,1);
  assert.equal(pin.trace.some(t=>t.url?.endsWith('/issues/7/labels') && t.method==='POST'),true);
});
test('Go cross targets, per-target packages and Windows GUI link mode are data',()=>{
  const cfg={release:{toolchains:['go'],goTargets:[{goos:'windows',goarch:'amd64'},{goos:'linux',goarch:'arm64',packages:['./cmd/probe']}],windowsGui:['./cmd/probe']}};
  const {result,trace}=probe('go/build.mjs',[],{},cfg);assert.equal(result.status,0,result.stderr);
  const builds=trace.filter(t=>t.command==='go' && t.args[0]==='build');
  assert.equal(builds.length,2);assert.equal(builds[0].goos,'windows');assert.equal(builds[1].goarch,'arm64');
  assert.ok(builds[0].args.some(a=>a.includes('-H windowsgui')));assert.equal(builds[1].args.some(a=>a.includes('windowsgui')),false);
  assert.ok(builds[1].args.includes('dist/probe-linux-arm64'));
});
test('a js/wasm release target is vetted as js/wasm and ships its wasm_exec.js',()=>{
  const cfg={release:{toolchains:['go'],goTargets:[{goos:'js',goarch:'wasm',packages:['.']}]}};
  const only=probe('go/test.mjs',[],{PROBE_GO_LIST:''},cfg);assert.equal(only.result.status,0,only.result.stderr);
  assert.deepEqual(only.trace.filter(t=>t.command==='go').map(t=>[t.args[0],t.goos || '']),[['list',''],['vet','js']]);
  const both=probe('go/test.mjs',[],{},cfg);
  assert.deepEqual(both.trace.filter(t=>t.command==='go').map(t=>[t.args[0],t.goos || '']),[['list',''],['vet',''],['test',''],['vet','js']]);
  assert.notEqual(probe('go/test.mjs',[],{PROBE_GO_LIST:''}).result.status,0,'no packages and no js/wasm target is an error');
  const goroot=fs.mkdtempSync(path.join(os.tmpdir(),'goroot-'));
  fs.mkdirSync(path.join(goroot,'lib','wasm'),{recursive:true});fs.writeFileSync(path.join(goroot,'lib','wasm','wasm_exec.js'),'// runtime');
  const build=probe('go/build.mjs',[],{PROBE_GOROOT:goroot},cfg);assert.equal(build.result.status,0,build.result.stderr);
  assert.ok(build.trace.some(t=>t.command==='go' && t.args[0]==='build' && t.goos==='js'));
  fs.rmSync(goroot,{recursive:true,force:true});
});
test('Go dependency dispatch opens and queues one PR', () => {
  const {result,trace} = probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod'},{go:{dependencies:['github.com/romaine-life/fzt']}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(trace.some(t=>t.url?.endsWith('/issues/7/labels')),true);
  const same=probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod',PROBE_OPEN:'identical'},{go:{dependencies:['github.com/romaine-life/fzt']}});
  assert.equal(same.result.status,0,same.result.stderr);
  assert.equal(same.trace.some(t=>t.method==='POST' && t.url?.endsWith('/pulls')),false);
  assert.ok(same.trace.some(t=>t.url?.endsWith('/issues/6/labels')));
  const newer=probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod',PROBE_OPEN:'superseded'},{go:{dependencies:['github.com/romaine-life/fzt']}});
  assert.equal(newer.result.status,0,newer.result.stderr);
  assert.equal(newer.trace.some(t=>t.method==='PATCH' && t.url.endsWith('/pulls/6')),true);
  assert.equal(newer.trace.some(t=>t.method==='DELETE' && t.url.endsWith('/branches/deps%2F0')),true);
});
test('web publication logs into ACR and direct deploy uses the digest pin', () => {
  const cfg={web:{image:'test.azurecr.io/probe',containerApp:'probe',resourceGroup:'test'}};
  const {result,trace}=probe('web-app/image.mjs',['publish'],{PROBE_IMAGE:'test.azurecr.io/probe'},cfg);
  assert.equal(result.status,0,result.stderr);
  assert.equal(trace.some(t=>t.command==='az' && t.args[0]==='acr'),true);
  const deploy=probe('web-app/deploy.mjs',[],{},cfg);
  assert.equal(deploy.result.status,0,deploy.result.stderr);
  assert.equal(deploy.trace.some(t=>t.command==='az' && t.args.includes('--image')),true);
});
test('manifest script executes every renderer, strict schemas and digest check', {skip:process.platform!=='linux'}, () => {
  const {result,trace} = probe('cluster-service/manifests.mjs',[],{}, {cluster:{renders:[{kind:'kustomize',path:'k8s'},{kind:'helm',path:'k8s',values:'k8s/values.yaml'}]}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(trace.filter(t=>t.command==='kubeconform').length,2);
  assert.equal(trace.filter(t=>t.command==='python3').length,2);
});


test('bot PRs are queued for merge-queue by their queue label',()=>{
  const cfg={cluster:{image:'forgejo.romaine.life/test/probe',baoRole:'probe-publish',baoSecret:'services/probe',pinFile:'k8s/deployment.yaml',workPackage:'https://openproject.home.romaine.life/wp/PIPT-12'}};
  for(const [script,args,settings,extra] of [['cluster-service/image.mjs',['publish'],cfg,{}],['cluster-service/pin.mjs',[],cfg,{}],['go/dependencies.mjs',[],{go:{dependencies:['github.com/romaine-life/fzt']}},{PROBE_DIFF:'go.mod'}]]) {
    const result=probe(script,args,extra,settings);assert.equal(result.result.status,0,result.result.stderr);
    assert.equal(result.trace.some(t=>t.url?.endsWith('/merge')),false);
    if(!script.endsWith('/image.mjs'))assert.equal(result.trace.some(t=>t.url?.endsWith('/issues/7/labels') && t.method==='POST'),true);
  }
});
