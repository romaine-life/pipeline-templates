import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';

export const goReleaserConfig = '.goreleaser.yaml';

// The Go programs a repository releases are the builds its .goreleaser.yaml lists: each one's
// id, buildmode and GOOS/GOARCH pairs (GoReleaser's targets, windows_amd64_v1). A repository
// without one releases no Go program.
export function goReleaserBuilds(file = goReleaserConfig) {
  if (!fs.existsSync(file)) return [];
  const builds = YAML.parse(fs.readFileSync(file, 'utf8'), {merge: true})?.builds;
  if (!Array.isArray(builds) || !builds.length) throw new Error(`${file} lists no builds`);
  return builds.map(build => {
    if (!build?.id || !build.main || !Array.isArray(build.targets) || !build.targets.length) throw new Error(`${file}: each build names its id, main and targets`);
    const targets = build.targets.map(target => { const [goos, goarch] = String(target).split('_'); return {goos, goarch}; });
    // cgo links a DLL on the Windows runner, so that is the only one there is.
    if (build.buildmode && (build.buildmode !== 'c-shared' || targets.some(t => t.goos !== 'windows' || t.goarch !== 'amd64'))) throw new Error(`${file}: ${build.id} is a c-shared windows_amd64 DLL or a program`);
    return {id: build.id, main: build.main, buildmode: build.buildmode || '', targets, ldflags: [build.ldflags ?? []].flat().join(' '), env: build.env || []};
  });
}

// The release jobs a Go release takes: one Linux job cross-builds every program, and the
// Windows runner builds the DLLs. Aliases are the targets a release dependency or archive
// selects the job by.
export function goParts(builds = goReleaserBuilds()) {
  if (!builds.length) throw new Error(`a Go release builds what ${goReleaserConfig} lists`);
  const programs = builds.filter(b => b.buildmode !== 'c-shared'), libraries = builds.filter(b => b.buildmode === 'c-shared');
  const parts = [];
  if (programs.length) parts.push({part: 'go', target: '', runner: 'ubuntu-latest', ids: programs.map(b => b.id), aliases: [...new Set(programs.flatMap(b => b.targets.map(t => `${t.goos}-${t.goarch}`)))]});
  if (libraries.length) parts.push({part: 'go-windows-amd64-c-shared', target: 'windows-amd64-c-shared', runner: 'windows-latest', ids: libraries.map(b => b.id), aliases: ['windows-amd64-c-shared']});
  return parts;
}

// Every program under cmd/ ships, as it did when the suite built ./cmd/... itself: a folder
// there that no build names is one left out of the release.
export function unreleasedCommands(builds = goReleaserBuilds()) {
  if (!fs.existsSync('cmd')) return [];
  const mains = new Set(builds.map(b => path.posix.normalize(b.main.replace(/^\.\//, ''))));
  return fs.readdirSync('cmd', {withFileTypes: true})
    .filter(entry => entry.isDirectory() && fs.readdirSync(path.join('cmd', entry.name)).some(file => file.endsWith('.go') && !file.endsWith('_test.go')))
    .map(entry => `cmd/${entry.name}`).filter(dir => !mains.has(dir));
}

// Every program and DLL a release builds carries its VERSION: its ldflags stamp it with
// -X <package>.<variable>={{ .Env.VERSION }}. The linker sets nothing, and says nothing, when
// that -X names a variable the program doesn't link, so each one is checked against the
// source on each of the build's targets: go list says the program links the package, and
// go doc that the package declares the variable. A program that never reads it still carries
// it; what it does with its version is its own. Returns every build's problems at once.
export function unstampedBuilds(builds = goReleaserBuilds()) {
  const problems = new Set(), linked = new Map(), declared = new Map();
  const environment = (build, {goos, goarch}) => {
    const cgo = build.env.find(e => e.startsWith('CGO_ENABLED='))?.split('=')[1] ?? (build.buildmode === 'c-shared' ? '1' : '0');
    return {GOOS: goos, GOARCH: goarch, CGO_ENABLED: cgo};
  };
  // One go list per target lists the packages each program links on it.
  const groups = new Map();
  for (const build of builds) for (const target of build.targets) {
    const env = environment(build, target), key = JSON.stringify(env);
    if (!groups.has(key)) groups.set(key, {env, mains: new Set()});
    groups.get(key).mains.add(build.main);
  }
  for (const [key, {env, mains}] of groups) {
    const list = [...mains], result = go(['list', '-f', '{{join .Deps " "}}', ...list], env);
    if (result.status !== 0) throw new Error(`go list ${list.join(' ')} exited ${result.status} on ${env.GOOS}/${env.GOARCH}`);
    const lines = result.stdout.split(/\r?\n/);
    list.forEach((main, i) => linked.set(`${key} ${main}`, new Set((lines[i] || '').split(' ').filter(Boolean))));
  }
  for (const build of builds) {
    const stamps = [...build.ldflags.matchAll(/-X[=\s]+([^\s=]+)=\{\{-?\s*\.Env\.VERSION\s*-?\}\}/g)].map(m => m[1]);
    if (!stamps.length) { problems.add(`${build.id}: its ldflags stamp VERSION into no variable (-X <package>.<variable>={{ .Env.VERSION }})`); continue; }
    for (const stamp of stamps) for (const target of build.targets) {
      const env = environment(build, target), on = `${env.GOOS}/${env.GOARCH}`;
      const cut = stamp.lastIndexOf('.'), pkg = stamp.slice(0, cut), name = stamp.slice(cut + 1);
      // The linker knows the program's own package as main; go doc reads it from its folder.
      const where = pkg === 'main' ? build.main : pkg;
      if (pkg !== 'main' && !linked.get(`${JSON.stringify(env)} ${build.main}`).has(pkg)) { problems.add(`${build.id}: stamps VERSION into ${stamp}, but ${build.main} doesn't link ${pkg} on ${on}`); continue; }
      const key = `${JSON.stringify(env)} ${where} ${name}`;
      if (!declared.has(key)) {
        const result = go(['doc', '-c', '-u', '-short', where, name], env);
        declared.set(key, result.status === 0 && /^var\b/.test(result.stdout.trim()));
      }
      if (!declared.get(key)) problems.add(`${build.id}: stamps VERSION into ${stamp}, which ${where} doesn't declare as a variable on ${on}`);
    }
  }
  return [...problems];
}
const go = (args, env) => {
  const result = spawnSync('go', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
  if (result.error) throw result.error;
  return {status: result.status, stdout: result.stdout || ''};
};
