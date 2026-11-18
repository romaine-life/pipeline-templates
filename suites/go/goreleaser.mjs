import fs from 'node:fs';
import path from 'node:path';
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
    return {id: build.id, main: build.main, buildmode: build.buildmode || '', targets};
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
