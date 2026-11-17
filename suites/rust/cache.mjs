import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {capture, kept} from '../lib.mjs';

export function targetDirectory(root, toolchain, job) {
  if (![toolchain, job].every(v => /^[\w.+-]+$/.test(v))) throw new Error('invalid Cargo cache key');
  const dir = path.join(root, toolchain, job);
  fs.mkdirSync(dir, {recursive: true});
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === toolchain) continue;
    const old = path.resolve(root, entry.name);
    if (path.dirname(old) !== path.resolve(root)) throw new Error('Cargo cleanup escaped its repository');
    try {
      if (process.platform === 'linux') {
        const result = spawnSync('flock', ['-n', '-x', `${old}.lock`, process.execPath, '-e',
          'require("node:fs").rmSync(process.argv[1], {recursive:true,force:true})', old], {stdio:'inherit'});
        if (result.error) throw result.error;
        if (result.status !== 0) console.log(`Cargo cache still in use: ${entry.name}`);
        continue;
      }
      const removing = old.endsWith('.removing') ? old : `${old}.removing`;
      if (old !== removing) fs.renameSync(old, removing);
      fs.rmSync(removing, {recursive: true});
    } catch (error) { console.log(`Cargo cache still in use: ${entry.name} (${error.code})`); }
  }
  return dir;
}
export function cargoCache(job) {
  const repo = (process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-');
  const toolchain = capture('rustc', ['--version']).replace(/[^\w.+-]/g, '-');
  const root = kept(`cargo-target/${repo}`);
  const key = process.env.GITHUB_JOB ? `${process.env.GITHUB_JOB}-${process.platform}` : job;
  const shared = targetDirectory(root, toolchain, key);
  // In CI, jobs of one repository can build at once in the kept folder. Cargo's lock covers a
  // build, not reading its outputs after, so a parallel build could replace them in between.
  // The compiled crates stay in the kept folder (Cargo's build-dir); the binaries and their
  // dependency lists come out into this job's own temporary folder.
  if (process.env.RUNNER_TEMP) {
    process.env.CARGO_BUILD_BUILD_DIR = shared;
    process.env.CARGO_TARGET_DIR = path.join(process.env.RUNNER_TEMP, 'cargo-target');
  } else process.env.CARGO_TARGET_DIR = shared;
  if (process.platform === 'linux' && process.env.CI_CARGO_LOCKED !== '1') {
    const result = spawnSync('flock', ['-n', '-s', path.join(root, `${toolchain}.lock`), process.execPath, ...process.argv.slice(1)],
      {stdio:'inherit',env:{...process.env,CI_CARGO_LOCKED:'1'}});
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
}
