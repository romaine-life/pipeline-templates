import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {suites} from '../lib.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';

// A .goreleaser.yaml with one build per [id, main, targets, buildmode, ldflags], each stamping
// VERSION into a buildinfo package's variable unless its ldflags say otherwise.
const stamp = "-s -w -X example.com/probe/internal/buildinfo.version={{ .Env.VERSION }}";
const goReleaser = builds => 'version: 2\nbuilds:\n' + builds.map(([id, main, targets, buildmode, ldflags = stamp]) =>
  `  - id: ${id}\n    main: ${main}\n    targets: [${targets.join(', ')}]\n${buildmode ? `    buildmode: ${buildmode}\n` : ''}    ldflags: '${ldflags}'\n`).join('');
const goMod = `module forgejo.romaine.life/romaine-life/probe

go 1.25

require github.com/romaine-life/fzt v0.2.1 // the picker

require (
	github.com/gdamore/tcell/v2 v2.7.0
	github.com/romaine-life/fzt-terminal v0.1.180
	github.com/romaine-life/auth v0.1.9 // indirect
)
`;
function probe(script, args = [], env = {}, cfg = {}, files = {}, inspect = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'suite-command-'));
  try {
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),text); }
    fleetEntry(({version:1,...cfg}),env.GITHUB_REPOSITORY || 'test/probe');
    fs.writeFileSync(path.join(root,'README.md'),'# A document\n');
    fs.writeFileSync(path.join(root,'config.json'),'{}');
    fs.writeFileSync(path.join(root,'main.go'),'package main\r\n');
    if (!('go.mod' in files)) fs.writeFileSync(path.join(root,'go.mod'),'module example.com/probe\n');
    fs.writeFileSync(path.join(root,'go.sum'),'dependency checksums\n');
    fs.writeFileSync(path.join(root,'.ci-image-pin'),`forgejo.romaine.life/test/probe:v0.1.1@sha256:${'b'.repeat(64)}`);
    fs.mkdirSync(path.join(root,'k8s'),{recursive:true});
    fs.writeFileSync(path.join(root,'k8s/deployment.yaml'),`image: forgejo.romaine.life/test/probe:v0.1.0@sha256:${'a'.repeat(64)}`);
    const log = path.join(root,'trace');
    const result = spawnSync(process.execPath,['--import',pathToFileURL(path.join(suites,'tests/probe.mjs')).href,path.join(suites,script),...args],{cwd:root,encoding:'utf8',env:{...process.env,
      CI_CACHE_ROOT:path.join(root,'cache'),CI_CARGO_LOCKED:'1',PROBE_LOG:log,BASE:'a'.repeat(40),GITHUB_EVENT_NAME:'push',DEFAULT_BRANCH:'main',GITHUB_REF:'refs/heads/main',
      GITHUB_REPOSITORY:'test/probe',GITHUB_SERVER_URL:'https://forgejo.romaine.life',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',VERSION:'v0.1.1',TOKEN:'test',PIN_TOKEN:'test',
      ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.invalid/oidc?',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'test',
      CI_TOOL_HELM:'helm',CI_TOOL_GORELEASER:'goreleaser',CI_TOOL_KUSTOMIZE:'kustomize',CI_TOOL_KUBECONFORM:'kubeconform',...env}});
    const trace = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    inspect(root);
    return {result,trace};
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('toolchain scripts execute standard commands and propagate failures', () => {
  for (const [script,expected,cfg,files] of [
    ['go/format.mjs',['git','gofmt'],{}],['go/test.mjs',['go','go','go'],{}],['go/build.mjs',['go','go','goreleaser'],{},{'.goreleaser.yaml':goReleaser([['probe','.',['linux_amd64_v1']]])}],
    ['rust/format.mjs',['cargo'],{}],['rust/test.mjs',['rustc','cargo','cargo'],{}],['rust/build.mjs',['rustc','cargo','cargo'],{}],
    ['web-app/test.mjs',process.platform === 'win32' ? ['npm.cmd','npm.cmd','npm.cmd'] : ['npm','npm','npm'],{}],
    ['powershell/files.mjs',['git'],{}],['docs/validate.mjs',['git','git','git'],{}],
    ['tofu/plan.mjs',['tofu','tofu','tofu','tofu'],{}],['tofu/apply.mjs',['tofu','tofu'],{}],
    ['default/fetches.mjs',[process.platform === 'win32' ? 'python' : 'python3'],{}],
    ['python/test.mjs',['git','python','uv','uv','uv','uv'],{}],
    ['python/build.mjs',['git','python','uv'],{}],
    ['dotnet/test.mjs',['dotnet','git','dotnet','dotnet','dotnet'],{}]
  ]) {
    const {result,trace} = probe(script,[],{},cfg,files);
    assert.equal(result.status,0,`${script}: ${result.stderr}`);
    assert.deepEqual(trace.filter(t=>t.command).map(t=>t.command),expected,script);
  }
  const uv = probe('python/test.mjs').trace.filter(t => t.command === 'uv' && t.args[0] === 'run').map(t => t.args.slice(2).join(' '));
  assert.deepEqual(uv, ["ruff check --config extend-exclude = ['_ci'] .", "ruff format --check --config extend-exclude = ['_ci'] .", 'pytest --ignore=_ci'], 'the suite checkout in _ci/ is not the repository\'s code');
  const gofmt = probe('go/format.mjs').trace.find(t => t.command === 'gofmt');
  assert.match(gofmt.args.at(-1).replaceAll('\\','/'),/gofmt-[^/]+\/main\.go$/,'a CRLF checkout of an LF commit is formatted from an LF copy');
  const committed = probe('go/format.mjs',[],{PROBE_GO_EOL:'lf'}).trace.find(t => t.command === 'gofmt');
  assert.equal(committed.args.at(-1),'main.go','a file is formatted as it is when the checkout matches the commit');
  const solution = probe('dotnet/test.mjs',[],{},{},{'Mod.sln':'','Mod.csproj':'<Project/>'}).trace.filter(t => t.command === 'dotnet' && t.args[0] !== '--version');
  assert.deepEqual(solution.map(t => t.args.slice(0,2)), [['restore','Mod.sln'],['format','Mod.sln'],['test','Mod.sln']], 'the root solution is built even beside a root project');
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
  const cfg = {suites:['cluster-service']}, tracked = {PROBE_TRACKED:'k8s/deployment.yaml'};
  let check = probe('cluster-service/image.mjs',['check'],tracked,cfg);
  assert.equal(check.result.status,0,check.result.stderr);
  assert.deepEqual(check.trace.filter(t=>t.command==='docker').map(t=>t.args[0]),['build','run','image']);
  const built=check.trace.find(t=>t.args?.[0]==='build').args.at(-2);
  assert.deepEqual(check.trace.at(-1).args,['image','rm',built],'the job removes the image it built');
  const publish = probe('cluster-service/image.mjs',['publish'],tracked,cfg);
  assert.equal(publish.result.status,0,publish.result.stderr);
  assert.deepEqual(publish.trace.filter(t=>t.command==='docker').at(-1).args.slice(0,2),['image','rm']);
  assert.equal(publish.trace.filter(t=>t.command==='docker').at(-1).args.length,4,'the job removes its image and the registry tag');
  assert.equal(publish.trace.some(t=>t.command==='docker' && t.args[0]==='run'),false);
  assert.equal(publish.trace.some(t=>t.command==='docker' && t.args[0]==='login' && t.input==='<stdin>'),true);
  // The registry sign-in is the job's own token for nelson's integration ci-image-publish:
  // no stored token is read (BAO-15).
  assert.ok(publish.trace.some(t=>t.url?.includes('oidc') && t.url.includes('audience=u%3A1%3Acd5766fe-554a-40dc-93a5-d8d6e441c444')));
  assert.equal(publish.trace.some(t=>t.url?.includes('bao.home.romaine.life')),false);
  // Refused, the publish fails: there is no stored token to fall back to.
  const refused = probe('cluster-service/image.mjs',['publish'],{...tracked,PROBE_REFUSE_LOGIN:'1'},cfg);
  assert.notEqual(refused.result.status,0);
  assert.equal(refused.trace.some(t=>t.url?.includes('bao.home.romaine.life')),false);
  const pin = probe('cluster-service/pin.mjs',[],{...tracked,PROBE_MERGED:'Moves the probe. https://openproject.home.romaine.life/wp/PIPT-30'},cfg);
  assert.equal(pin.result.status,0,pin.result.stderr);
  assert.equal(pin.trace.filter(t=>t.url?.endsWith('/pulls')).length,1);
  // The pin PR links the work package the PR its release merged links.
  assert.match(pin.trace.find(t=>t.url?.endsWith('/pulls')).body.body,/ https:\/\/openproject\.home\.romaine\.life\/wp\/PIPT-30$/);
  assert.notEqual(probe('cluster-service/pin.mjs',[],{},cfg).result.status,0,'no file pins the image');
  assert.equal(pin.trace.some(t=>t.url?.endsWith('/issues/7/labels') && t.method==='POST'),true);
});
test('a pin is made on the default branch as it is now, and supersedes an older open pin, never a newer one',()=>{
  const cfg = {suites:['cluster-service']};
  const older = probe('cluster-service/pin.mjs',[],{VERSION:'v0.1.10',PROBE_OPEN_PIN:'v0.1.9',PROBE_TRACKED:'k8s/deployment.yaml'},cfg);
  assert.equal(older.result.status,0,older.result.stderr);
  const git = older.trace.filter(t=>t.command==='git').map(t=>t.args.slice(0,2).join(' '));
  assert.ok(git.indexOf('fetch --no-tags') >= 0 && git.indexOf('fetch --no-tags') < git.indexOf('checkout -B'), git.join(', '));
  assert.ok(older.trace.some(t=>t.command==='git' && t.args[0]==='checkout' && t.args.at(-1)==='FETCH_HEAD'));
  assert.equal(older.trace.filter(t=>t.url?.endsWith('/pulls')).length,1);
  assert.equal(older.trace.some(t=>t.url?.endsWith('/pulls/5') && t.method==='PATCH' && t.body?.state==='closed'),true);
  assert.equal(older.trace.some(t=>t.url?.endsWith('/branches/ci-pin%2Fv0.1.9') && t.method==='DELETE'),true);
  const newer = probe('cluster-service/pin.mjs',[],{VERSION:'v0.1.10',PROBE_OPEN_PIN:'v0.1.11',PROBE_TRACKED:'k8s/deployment.yaml'},cfg);
  assert.equal(newer.result.status,0,newer.result.stderr);
  assert.equal(newer.trace.some(t=>t.url?.endsWith('/pulls') || t.method==='PATCH'),false);
});
test('a Go release job builds its builds from .goreleaser.yaml, and every program under cmd/ is one',()=>{
  const files={'.goreleaser.yaml':goReleaser([['probe','./cmd/probe',['windows_amd64_v1','linux_arm64_v8.0']],['dll','./cmd/dll',['windows_amd64_v1'],'c-shared']]),'cmd/probe/main.go':'package main\n','cmd/dll/main.go':'package main\n'};
  const listed=root=>fs.readdirSync(path.join(root,'dist')).sort();
  let dist;
  const programs=probe('go/build.mjs',[],{PROBE_GORELEASER:JSON.stringify([{name:'probe.exe',type:'Binary',goos:'windows'},{name:'probe-linux-arm64',type:'Binary',goos:'linux'}])},{},files,root=>{dist=listed(root);});
  assert.equal(programs.result.status,0,programs.result.stderr);
  const run=programs.trace.find(t=>t.command==='goreleaser');
  assert.deepEqual(run.args.filter((_,i)=>run.args[i-1]==='--id'),['probe'],'the Linux job builds the programs');
  assert.deepEqual(dist,['probe-linux-arm64','probe.exe'],"GoReleaser's metadata stays out of the release");
  const library=probe('go/build.mjs',[],{RELEASE_PART:'go-windows-amd64-c-shared',PROBE_GORELEASER:JSON.stringify([{name:'dll.dll',type:'C Shared Library',goos:'windows'},{name:'dll.h',type:'Header',goos:'windows'}])},{},files,root=>{dist=listed(root);});
  assert.equal(library.result.status,0,library.result.stderr);
  const dll=library.trace.find(t=>t.command==='goreleaser');
  assert.deepEqual(dll.args.filter((_,i)=>dll.args[i-1]==='--id'),['dll'],'the Windows job builds the DLLs');
  assert.deepEqual(dist,['dll.dll']);
  assert.ok(library.trace.some(t=>t.command==='objdump'),"a DLL's imports are checked for MinGW runtime DLLs");
  const unstamped=probe('go/build.mjs',[],{PROBE_GO_DOC:''},{},files);
  assert.notEqual(unstamped.result.status,0);assert.equal(unstamped.trace.some(t=>t.command==='goreleaser'),false,'nothing builds');
  assert.match(unstamped.result.stderr,/probe: stamps VERSION into example\.com\/probe\/internal\/buildinfo\.version, which example\.com\/probe\/internal\/buildinfo doesn't declare as a variable on windows\/amd64/);
  const unlisted=probe('go/build.mjs',[],{},{},{...files,'cmd/extra/main.go':'package main\n'});
  assert.notEqual(unlisted.result.status,0);assert.match(unlisted.result.stderr,/builds no program from cmd\/extra/);
  assert.notEqual(probe('go/build.mjs').result.status,0,'a Go release needs .goreleaser.yaml');
});
test('a release copies the files under release/assets/<toolchain> beside the built ones',()=>{
  const cfg={release:{toolchains:['go']}};
  const {result}=probe('release/build.mjs',[],{RELEASE_TOOLCHAIN:'go'},cfg,{'.goreleaser.yaml':goReleaser([['probe','.',['linux_amd64_v1']]]),'release/assets/go/site.css':'body{}','release/assets/go/fonts/a.ttf':'font'});
  assert.equal(result.status,0,result.stderr);
});
test("an OpenTofu provider's release build publishes its programs as tofu's packages, and its assembly holds Linux's and Windows'",()=>{
  // The probe runs no toolchain build, so the programs come in as the build's static assets.
  const cfg={suites:['release','go'],release:{toolchains:['go'],tofuProvider:true}};
  const files={'.goreleaser.yaml':goReleaser([['provider','.',['linux_amd64_v1','windows_amd64_v1']]]),
    'release/assets/go/terraform-provider-probe-linux-amd64':'program','release/assets/go/terraform-provider-probe-windows-amd64.exe':'program'};
  const env={RELEASE_TOOLCHAIN:'go',VERSION:'v0.1.4',GITHUB_REPOSITORY:'romaine-life/terraform-provider-probe'};
  let dist;
  const built=probe('release/build.mjs',[],env,cfg,files,root=>{dist=fs.readdirSync(path.join(root,'dist')).sort();});
  assert.equal(built.result.status,0,built.result.stderr);
  assert.deepEqual(dist,['terraform-provider-probe_0.1.4_linux_amd64.zip','terraform-provider-probe_0.1.4_windows_amd64.zip']);
  const part=list=>Object.fromEntries(list.map(file=>[`parts/release-go/${file}`,'package']));
  const assembled=probe('release/assemble.mjs',[],{GITHUB_REPOSITORY:env.GITHUB_REPOSITORY},cfg,part(dist));
  assert.equal(assembled.result.status,0,assembled.result.stderr);
  const linuxOnly=probe('release/assemble.mjs',[],{GITHUB_REPOSITORY:env.GITHUB_REPOSITORY},cfg,part([dist[0]]));
  assert.notEqual(linuxOnly.result.status,0);assert.match(linuxOnly.result.stderr,/no terraform-provider-probe package for windows_amd64/);
  // A pull request's check build has no VERSION; its packages still build and assemble.
  const unversioned={...env,VERSION:''};
  let checked;
  const check=probe('release/build.mjs',[],unversioned,cfg,files,root=>{checked=fs.readdirSync(path.join(root,'dist')).sort();});
  assert.equal(check.result.status,0,check.result.stderr);
  assert.deepEqual(checked,['terraform-provider-probe_0.0.0_linux_amd64.zip','terraform-provider-probe_0.0.0_windows_amd64.zip']);
  assert.equal(probe('release/assemble.mjs',[],{GITHUB_REPOSITORY:env.GITHUB_REPOSITORY},cfg,part(checked)).result.status,0);
});
test("a pull request's Go tests fail on a program under cmd/ that .goreleaser.yaml doesn't build",()=>{
  const files={'.goreleaser.yaml':goReleaser([['probe','./cmd/probe',['windows_amd64_v1']]]),'cmd/probe/main.go':'package main\n'};
  const listed=probe('go/test.mjs',[],{},{},files);assert.equal(listed.result.status,0,listed.result.stderr);
  const unlisted=probe('go/test.mjs',[],{},{},{...files,'cmd/extra/main.go':'package main\n'});
  assert.notEqual(unlisted.result.status,0);assert.match(unlisted.result.stderr,/builds no program from cmd\/extra/);
  assert.equal(probe('go/test.mjs',[],{},{},{'cmd/tool/main.go':'package main\n'}).result.status,0,'a repository releasing no Go program has nothing to list');
});
test("a pull request's Go tests list every build whose VERSION stamp names no variable the program links",()=>{
  const files={'.goreleaser.yaml':goReleaser([['a','./cmd/a',['windows_amd64_v1','linux_amd64_v1']],['b','./cmd/b',['windows_amd64_v1']],['c','./cmd/c',['windows_amd64_v1'],'','-s -w -X main.version={{ .Env.VERSION }}']]),
    'cmd/a/main.go':'package main\n','cmd/b/main.go':'package main\n','cmd/c/main.go':'package main\n'};
  const stamped=probe('go/test.mjs',[],{},{},files);assert.equal(stamped.result.status,0,stamped.result.stderr);
  const lists=stamped.trace.filter(t=>t.command==='go' && t.args[1]==='-f');
  assert.deepEqual(lists.map(t=>[t.goos,t.args.slice(3)]),[['windows',['./cmd/a','./cmd/b','./cmd/c']],['linux',['./cmd/a']]],'one go list per target');
  const docs=stamped.trace.filter(t=>t.command==='go' && t.args[0]==='doc').map(t=>[t.goos,...t.args.slice(-2)]);
  assert.deepEqual(docs,[['windows','example.com/probe/internal/buildinfo','version'],['linux','example.com/probe/internal/buildinfo','version'],['windows','./cmd/c','version']],"a package's variable is looked up once per target, and main's in the program's folder");
  const unlinked=probe('go/test.mjs',[],{PROBE_GO_DEPS:''},{},files);
  assert.notEqual(unlinked.result.status,0);
  for (const line of ["a: stamps VERSION into example.com/probe/internal/buildinfo.version, but ./cmd/a doesn't link example.com/probe/internal/buildinfo on windows/amd64",
    "a: stamps VERSION into example.com/probe/internal/buildinfo.version, but ./cmd/a doesn't link example.com/probe/internal/buildinfo on linux/amd64",
    "b: stamps VERSION into example.com/probe/internal/buildinfo.version, but ./cmd/b doesn't link example.com/probe/internal/buildinfo on windows/amd64"]) assert.ok(unlinked.result.stderr.includes(line),line);
  assert.doesNotMatch(unlinked.result.stderr,/^c:/m,'main is the program itself');
  const func=probe('go/test.mjs',[],{PROBE_GO_DOC:'func version()'},{},files);
  assert.match(func.result.stderr,/c: stamps VERSION into main\.version, which \.\/cmd\/c doesn't declare as a variable on windows\/amd64/);
  const none=probe('go/test.mjs',[],{},{},{'.goreleaser.yaml':goReleaser([['a','./cmd/a',['windows_amd64_v1'],'','-s -w -X example.com/probe/internal/buildinfo.version=v1']]),'cmd/a/main.go':'package main\n'});
  assert.match(none.result.stderr,/a: its ldflags stamp VERSION into no variable/);
});
test('go-race runs every package under the race detector, with cgo, on Linux',()=>{
  const {result,trace}=probe('go/test.mjs',[],{},{go:{race:['./...']}});
  assert.equal(result.status,0,result.stderr);
  const raced=trace.filter(t=>t.command==='go' && t.args.includes('-race'));
  if (process.platform==='linux') assert.deepEqual(raced.map(t=>t.args.slice(-1)),[['./...']]);
  else assert.equal(raced.length,0,'the race detector runs only on Linux');
});
test('a js/wasm release target is vetted as js/wasm and ships its wasm_exec.js',()=>{
  const cfg={release:{toolchains:['go']}},files={'.goreleaser.yaml':goReleaser([['fzt','.',['js_wasm']]])};
  const only=probe('go/test.mjs',[],{PROBE_GO_LIST:''},cfg,files);assert.equal(only.result.status,0,only.result.stderr);
  const checks=[['list','js'],['doc','js']];
  assert.deepEqual(only.trace.filter(t=>t.command==='go').map(t=>[t.args[0],t.goos || '']),[...checks,['list',''],['vet','js']]);
  const both=probe('go/test.mjs',[],{},cfg,files);
  assert.deepEqual(both.trace.filter(t=>t.command==='go').map(t=>[t.args[0],t.goos || '']),[...checks,['list',''],['vet',''],['test',''],['vet','js']]);
  assert.notEqual(probe('go/test.mjs',[],{PROBE_GO_LIST:''}).result.status,0,'no packages and no js/wasm target is an error');
  const goroot=fs.mkdtempSync(path.join(os.tmpdir(),'goroot-'));
  fs.mkdirSync(path.join(goroot,'lib','wasm'),{recursive:true});fs.writeFileSync(path.join(goroot,'lib','wasm','wasm_exec.js'),'// runtime');
  let shipped;
  const build=probe('go/build.mjs',[],{PROBE_GOROOT:goroot,PROBE_GORELEASER:JSON.stringify([{name:'fzt.wasm',type:'Binary',goos:'js'}])},cfg,files,root=>{shipped=fs.readdirSync(path.join(root,'dist')).sort();});
  assert.equal(build.result.status,0,build.result.stderr);
  assert.deepEqual(shipped,['fzt.wasm','wasm_exec.js']);
  fs.rmSync(goroot,{recursive:true,force:true});
});
test('Go dependency dispatch takes every romaine-life module go.mod requires, and opens and queues one PR', () => {
  const {result,trace} = probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod'},{},{'go.mod':goMod});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(trace.find(t=>t.command==='go' && t.args[0]==='get').args,['get','-p','4','github.com/romaine-life/auth@latest','github.com/romaine-life/fzt@latest','github.com/romaine-life/fzt-terminal@latest']);
  assert.equal(trace.some(t=>t.url?.endsWith('/issues/7/labels')),true);
  const none=probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod'},{},{'go.mod':'module github.com/romaine-life/fzt\n\nrequire github.com/gdamore/tcell/v2 v2.7.0\n'});
  assert.equal(none.result.status,0,none.result.stderr);
  assert.equal(none.trace.some(t=>t.command==='go'),false);
  const same=probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod',PROBE_OPEN:'identical'},{},{'go.mod':goMod});
  assert.equal(same.result.status,0,same.result.stderr);
  assert.equal(same.trace.some(t=>t.method==='POST' && t.url?.endsWith('/pulls')),false);
  assert.ok(same.trace.some(t=>t.url?.endsWith('/issues/6/labels')));
  const newer=probe('go/dependencies.mjs',[],{PROBE_DIFF:'go.mod',PROBE_OPEN:'superseded'},{},{'go.mod':goMod});
  assert.equal(newer.result.status,0,newer.result.stderr);
  assert.equal(newer.trace.some(t=>t.method==='PATCH' && t.url.endsWith('/pulls/6')),true);
  assert.equal(newer.trace.some(t=>t.method==='DELETE' && t.url.endsWith('/branches/deps%2F0')),true);
});
test('web publication logs into ACR, and its pin PR moves the file that pins the image', () => {
  const cfg={suites:['web-app'],web:{image:true}},files={'k8s/values.yaml':`image: romainecr.azurecr.io/probe:v0.1.0@sha256:${'a'.repeat(64)}\n`};
  const env={PROBE_IMAGE:'romainecr.azurecr.io/probe',PROBE_TRACKED:'k8s/deployment.yaml,k8s/values.yaml'};
  const {result,trace}=probe('web-app/image.mjs',['publish'],env,cfg,files);
  assert.equal(result.status,0,result.stderr);
  assert.ok(trace.some(t=>t.command==='az' && t.args.join(' ')==='acr login --name romainecr'));
  const deploy=probe('cluster-service/pin.mjs',['web'],env,cfg,files);
  assert.equal(deploy.result.status,0,deploy.result.stderr);
  assert.ok(deploy.trace.some(t=>t.command==='git' && t.args.join(' ')==='add -- k8s/values.yaml'));
});
test('manifest script executes every renderer, strict schemas and digest check', {skip:process.platform!=='linux'}, () => {
  const {result,trace} = probe('cluster-service/manifests.mjs',[],{PROBE_TRACKED:'k8s/Chart.yaml,k8s/values.yaml,k8s/values-case.yaml'}, {suites:['cluster-service']});
  assert.equal(result.status,0,result.stderr);
  assert.equal(trace.filter(t=>t.command==='kubeconform').length,2);
  assert.equal(trace.filter(t=>t.command==='python3').length,2);
});


test('bot PRs are queued for merge-queue by their queue label',()=>{
  const cfg={suites:['cluster-service']},tracked={PROBE_TRACKED:'k8s/deployment.yaml'};
  for(const [script,args,settings,extra,files] of [['cluster-service/image.mjs',['publish'],cfg,tracked],['cluster-service/pin.mjs',[],cfg,tracked],['go/dependencies.mjs',[],{},{PROBE_DIFF:'go.mod'},{'go.mod':goMod}]]) {
    const result=probe(script,args,extra,settings,files);assert.equal(result.result.status,0,result.result.stderr);
    assert.equal(result.trace.some(t=>t.url?.endsWith('/merge')),false);
    if(!script.endsWith('/image.mjs'))assert.equal(result.trace.some(t=>t.url?.endsWith('/issues/7/labels') && t.method==='POST'),true);
  }
});
