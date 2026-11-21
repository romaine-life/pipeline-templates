// A release dependency whose source keeps only its newest file under one name (mGBA's
// development build, `latest` in release/dependencies.json, layout.mjs): its release reads the
// copy its lock pins from Artifact Keeper's hosted snapshots repository, which nothing but this
// take-up writes. The take-up (release/dependencies.yml, run from the Actions tab) downloads the
// newest file, and when it differs from the pin, copies it there under its version and proposes
// the lock that pins it. A copy already there is never replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash} from '../lib.mjs';
import {config} from '../config.mjs';
import {snapshots} from '../layout.mjs';
import {extract, fileVersion} from './archive.mjs';
import {readLock} from './dependencies.mjs';

const artifactKeeper = 'https://artifacts.home.romaine.life';

// The series a release that builds nothing numbers on (version-from-manifest): the version its
// one `version` download's lock pins, 0.11.9187 giving v0.11.9187.N.
export function pinnedSeries(cfg) {
  const release = cfg.release || {};
  if (!release.fromManifest || release.toolchains?.length || release.external?.length || release.module) return null;
  const pinned = (release.dependencies || []).filter(item => item.version);
  if (pinned.length !== 1) throw new Error('version-from-manifest: a release that builds nothing numbers on the one download whose lock pins its version (a version pattern in release/dependencies.json)');
  const lock = pinned[0].lock;
  if (!fs.existsSync(lock)) throw new Error(`${lock} is missing: the dependency take-up (Suite release dependencies, run from the Actions tab) pins ${pinned[0].latest}`);
  const {tag} = readLock(lock);
  if (!/^[0-9][0-9A-Za-z.]*$/.test(tag)) throw new Error(`${lock} pins ${tag}, which isn't a version to number a series on`);
  return `v${tag}`;
}

async function download(url, token) {
  const headers = new URL(url).hostname === 'forgejo.romaine.life' && token ? {Authorization: `token ${token}`} : {};
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(300000)});
  if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Puts bytes at a snapshot address once: one already there must be the same file.
export async function store(url, bytes, {signIn} = {}) {
  if (!url.startsWith(`${snapshots}/`)) throw new Error(`${url} isn't in the snapshots repository`);
  const held = await fetch(url, {signal: AbortSignal.timeout(300000)});
  if (held.ok) {
    if (hash(Buffer.from(await held.arrayBuffer())) !== hash(bytes)) throw new Error(`${url} already holds another file`);
    return 'already there';
  }
  if (held.status !== 404) throw new Error(`reading ${url}: HTTP ${held.status}`);
  const token = await (signIn || (await import('./tofu-provider.mjs')).signIn)();
  const put = await fetch(`${artifactKeeper}/api/v1/repositories/snapshots/artifacts/${url.slice(snapshots.length + 1)}`, {
    method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream'}, body: bytes, signal: AbortSignal.timeout(300000)});
  if (!put.ok) throw new Error(`uploading ${url}: HTTP ${put.status}: ${(await put.text()).slice(0, 500)}`);
  const check = await fetch(url, {signal: AbortSignal.timeout(300000)});
  if (!check.ok || hash(Buffer.from(await check.arrayBuffer())) !== hash(bytes)) throw new Error(`${url} doesn't serve what was uploaded`);
  return 'stored';
}

// The version a downloaded file's pin is named by: its `version` entry's pattern, read in the file
// that entry takes; without one, the start of its SHA-256.
async function versionOf(file, entries) {
  const entry = entries.find(item => item.version);
  if (!entry) return hash(fs.readFileSync(file)).slice(0, 16);
  if (!entry.extract) return fileVersion(fs.readFileSync(file), entry.version);
  const out = path.join(path.dirname(file), 'version-file');
  await extract(file, entry.extract, out);
  return fileVersion(fs.readFileSync(out), entry.version);
}

// Each lock of a latest dependency, moved to the source's newest file when it changed. Returns
// the locks it read and what moved, as `<file> <old> -> <new>`.
export async function takeUpSnapshots({cfg = config(), token = process.env.TOKEN, signIn} = {}) {
  const groups = new Map();
  for (const item of cfg.release?.dependencies || []) if (item.latest) groups.set(item.lock, [...(groups.get(item.lock) || []), item]);
  const moved = [];
  for (const [lock, entries] of groups) {
    const name = new URL(entries[0].latest).pathname.split('/').pop();
    const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'snapshot-'));
    try {
      const bytes = await download(entries[0].latest, token), sha = hash(bytes);
      const old = fs.existsSync(lock) ? readLock(lock) : null;
      if (old?.sha256 === sha) { console.log(`${lock}: ${name} ${old.tag} is the newest`); continue; }
      const file = path.join(temp, name);
      fs.writeFileSync(file, bytes);
      const tag = await versionOf(file, entries);
      const url = entries[0].url.replace('{tag}', encodeURIComponent(tag));
      console.log(`${url}: ${await store(url, bytes, {signIn})}`);
      fs.mkdirSync(path.dirname(lock), {recursive: true});
      fs.writeFileSync(lock, `${tag} ${sha}\n`);
      moved.push(`${name} ${old?.tag || '(none)'} -> ${tag}`);
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  }
  return {locks: [...groups.keys()], moved};
}
