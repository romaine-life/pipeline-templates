// Writes the lock for the shared provider set (providers/providers.tf), so no person ever
// does (IB-3). Run by .forgejo/workflows/tofu-providers.yml on a pull request that changes the
// set: the lock is made fresh from Artifact Keeper's mirrors, for linux_amd64 alone (the tofu
// suite's jobs are ubuntu-latest), and when it differs from the committed one CI commits it to
// the pull request's branch as forgejo-actions and this run fails; the run its push starts
// checks the lock it wrote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture, run} from '../lib.mjs';

export const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers');
export const lockFile = path.join(dir, '.terraform.lock.hcl');
const cache = 'https://artifacts.home.romaine.life';
const ours = 'artifacts.home.romaine.life/';
// The two mirrors home-cache's tofu.tfrc names: OpenTofu's registry, and our own providers.
export const mirrors = [
  {url: `${cache}/terraform/opentofu/`, owns: source => !source.startsWith(ours)},
  {url: `${cache}/terraform/tofu-providers/`, owns: source => source.startsWith(ours)},
];

// Each provider's source address in the set, by its configuration's `source = "..."` lines.
export function sources(text) {
  return [...text.matchAll(/\bsource\s*=\s*"([^"]+)"/g)].map(m => m[1]);
}

export function generate({exec = run} = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tofu-providers-'));
  try {
    fs.copyFileSync(path.join(dir, 'providers.tf'), path.join(work, 'providers.tf'));
    const all = sources(fs.readFileSync(path.join(work, 'providers.tf'), 'utf8'));
    for (const mirror of mirrors) {
      const named = all.filter(mirror.owns);
      if (named.length) exec('tofu', [`-chdir=${work}`, 'providers', 'lock', `-net-mirror=${mirror.url}`, '-platform=linux_amd64', ...named]);
    }
    return fs.readFileSync(path.join(work, '.terraform.lock.hcl'), 'utf8');
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = generate();
  const held = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null;
  if (held === lock) { console.log('The committed lock is the one the set gives.'); process.exit(0); }
  fs.writeFileSync(lockFile, lock);
  const branch = process.env.HEAD_REF;
  const token = process.env.PUSH_TOKEN;
  if (!branch || !token) throw new Error('the lock differs, and with no HEAD_REF and PUSH_TOKEN CI can\'t commit it');
  const env = {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
  run('git', ['add', '--', path.relative(process.cwd(), lockFile)]);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', 'Write the shared provider set\'s lock']);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  console.log(capture('git', ['rev-parse', 'HEAD']).trim());
  console.error('CI wrote the shared provider set\'s lock and pushed it to this branch; the run that push starts checks it.');
  process.exit(1);
}
