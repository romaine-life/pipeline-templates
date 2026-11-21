import fs from 'node:fs';
import path from 'node:path';
import TOML from '@iarna/toml';
import {capture, kept, run, tracked} from '../lib.mjs';
import {rustBuilds} from '../topics.mjs';

// A Game Boy Advance ROM (rust-build-gba) is an agb crate as agb's template lays it out: the
// folder whose .cargo/config.toml builds for the GBA (`[build] target`) and builds the standard
// library there too (`[unstable] build-std`). Cargo reads that file from the folder it runs in,
// and it would reach every crate of one workspace, so the crate is a workspace of its own and
// its checks and build run in its folder. Its programs become ROMs through agb-gbafix.
export const gbaTarget = rustBuilds.gba;
const readFile = file => fs.readFileSync(file, 'utf8');

// The tracked folders whose .cargo/config.toml builds for the GBA, `.` for the root.
export function gbaFolders(files = tracked(), read = readFile) {
  return files.filter(file => file === '.cargo/config.toml' || file.endsWith('/.cargo/config.toml')).filter(file => {
    const text = read(file);
    if (!text.includes(gbaTarget)) return false;
    let config;
    try { config = TOML.parse(text); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    return config.build?.target === gbaTarget;
  }).map(file => path.posix.dirname(path.posix.dirname(file))).sort();
}

// agb-gbafix is released with agb, at agb's version, so it is the one the crate's Cargo.lock holds.
export function agbVersion(lock) {
  const versions = [...new Set((TOML.parse(lock).package || []).filter(item => item.name === 'agb').map(item => item.version))];
  if (versions.length !== 1) throw new Error(`a GBA crate's Cargo.lock holds one agb version, which agb-gbafix matches; it holds ${versions.length ? versions.join(', ') : 'none'}`);
  return versions[0];
}

// The ROM header's title, at most 12 bytes: the program's name in capitals with spaces for its
// hyphens and underscores (power-lines is POWER LINES).
export const romTitle = name => name.toUpperCase().replace(/[-_]/g, ' ').slice(0, 12).trimEnd();

// Installed into the runner's kept folder, from outside the repository, where no
// .cargo/config.toml builds for the GBA.
function gbafix(version) {
  const compiler = capture('rustc', ['--version']).replace(/[^\w.-]/g, '-');
  const root = kept(`rust-tools/agb-gbafix/${version}/${compiler}`);
  const executable = path.join(root, 'bin', `agb-gbafix${process.platform === 'win32' ? '.exe' : ''}`);
  if (!fs.existsSync(executable)) run('cargo', ['install', '--locked', '-j', '4', '--root', root, `agb-gbafix@${version}`],
    {cwd: root, env: {CARGO_TARGET_DIR: path.join(root, 'target'), CARGO_BUILD_BUILD_DIR: path.join(root, 'target')}});
  return executable;
}

// The release build: the crate's programs, built in its folder, each as dist/<program>.gba.
export function buildRoms({part, features = [], noDefault = false, folders = gbaFolders()} = {}) {
  if (folders.length !== 1) throw new Error(`a GBA release builds one agb crate, the folder whose .cargo/config.toml builds ${gbaTarget}; this repository has ${folders.length ? folders.join(', ') : 'none'}`);
  const [folder] = folders;
  run('cargo', ['build', '-j', '4', '--locked', '--release', ...(part?.package ? ['-p', part.package] : ['--workspace']), '--target', gbaTarget,
    ...(noDefault ? ['--no-default-features'] : []), ...(features.length ? ['--features', features.join(',')] : [])], {cwd: folder});
  const metadata = JSON.parse(capture('cargo', ['metadata', '--no-deps', '--format-version', '1'], {cwd: folder}));
  const programs = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id) && (!part?.package || pkg.name === part.package))
    .flatMap(pkg => pkg.targets.filter(item => item.kind.includes('bin')));
  if (!programs.length) throw new Error(`the GBA crate in ${folder} builds no program`);
  const lock = [path.join(folder, 'Cargo.lock'), 'Cargo.lock'].find(file => fs.existsSync(file));
  if (!lock) throw new Error(`the GBA crate in ${folder} has no Cargo.lock`);
  const executable = gbafix(agbVersion(readFile(lock)));
  fs.mkdirSync('dist', {recursive: true});
  for (const program of programs) {
    run(executable, [path.join(process.env.CARGO_TARGET_DIR, gbaTarget, 'release', program.name), '--title', romTitle(program.name), '-o', path.join('dist', `${program.name}.gba`)]);
  }
}
