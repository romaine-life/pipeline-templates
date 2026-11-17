import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, kept, request, requirePublish, safePath} from '../lib.mjs';
import {config} from '../config.mjs';
import {proposeDependencies, pushEnv} from '../deps-pr.mjs';

// An image's inputs from other repositories (web.dependencies): a release asset or a file at
// a release's tag, each pinned in dependencies.lock as `<destination> <tag> <sha256>`. The
// image build stages exactly the pinned bytes; a dispatch from the source's release rewrites
// the lock to its newest release and proposes that as a take-up PR.
export const lockFile = 'dependencies.lock';
const server = () => process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life';

export function readLock(text) {
  const entries = new Map();
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const fields = line.split(/\s+/);
    if (fields.length !== 3 || !/^[\w.+-]+$/.test(fields[1]) || !/^[0-9a-f]{64}$/.test(fields[2])) throw new Error(`${lockFile}: expected <destination> <tag> <sha256>: ${line}`);
    safePath(fields[0]);
    if (entries.has(fields[0])) throw new Error(`${lockFile}: ${fields[0]} is pinned twice`);
    entries.set(fields[0], {tag: fields[1], sha256: fields[2]});
  }
  return entries;
}
export const writeLock = entries => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([destination, {tag, sha256}]) => `${destination} ${tag} ${sha256}\n`).join('');

export function sourceURL(dependency, tag, base = server()) {
  return dependency.asset
    ? `${base}/${dependency.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(dependency.asset)}`
    : `${base}/api/v1/repos/${dependency.repository}/raw/${dependency.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(tag)}`;
}

async function download(url, token) {
  const response = await fetch(url, {headers: {Authorization: `token ${token}`}, signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Every declared input is pinned, every pin is declared, and the staged bytes match their pins.
export async function stage(dependencies = config().web?.dependencies || [], {get = download, token = process.env.DEPENDENCY_TOKEN, cache = () => kept('release-inputs')} = {}) {
  if (!dependencies.length) return;
  if (!token) throw new Error('pinned image inputs need DEPENDENCY_TOKEN');
  const lock = readLock(fs.readFileSync(lockFile, 'utf8'));
  for (const destination of lock.keys()) if (!dependencies.some(d => d.destination === destination)) throw new Error(`${lockFile} pins ${destination}, which web.dependencies doesn't declare`);
  for (const dependency of dependencies) {
    const pin = lock.get(dependency.destination);
    if (!pin) throw new Error(`${dependency.destination} isn't pinned in ${lockFile}`);
    const file = path.join(cache(), pin.sha256);
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== pin.sha256) {
      const bytes = await get(sourceURL(dependency, pin.tag), token);
      if (hash(bytes) !== pin.sha256) throw new Error(`${dependency.destination}: ${dependency.repository} ${pin.tag} doesn't match its pinned checksum`);
      const temp = `${file}.${process.pid}`;
      fs.writeFileSync(temp, bytes);
      try { fs.renameSync(temp, file); } catch (error) { fs.unlinkSync(temp); if (!fs.existsSync(file)) throw error; }
    }
    fs.mkdirSync(path.dirname(dependency.destination), {recursive: true});
    fs.copyFileSync(file, dependency.destination);
    console.log(`${dependency.destination}: ${dependency.repository} ${pin.tag}`);
  }
}

// The lock each source's newest release would give.
export async function newest(dependencies, {get = download, latest = repository => request(`${server()}/api/v1/repos/${repository}/releases/latest`), token} = {}) {
  const entries = new Map(), tags = new Map();
  for (const dependency of dependencies) {
    if (!tags.has(dependency.repository)) tags.set(dependency.repository, (await latest(dependency.repository)).tag_name);
    const tag = tags.get(dependency.repository);
    entries.set(dependency.destination, {tag, sha256: hash(await get(sourceURL(dependency, tag), token))});
  }
  return entries;
}

export async function bump() {
  requirePublish();
  const dependencies = config().web?.dependencies || [];
  if (!dependencies.length) throw new Error('web.dependencies is empty');
  const token = process.env.TOKEN;
  if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN');
  const text = writeLock(await newest(dependencies, {token}));
  if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === text) { console.log(`${lockFile} is current`); return; }
  fs.writeFileSync(lockFile, text);
  const sources = [...new Set(dependencies.map(d => d.repository))].join(', ');
  await proposeDependencies({files: [lockFile], title: 'Take pinned image inputs', message: `Take the newest ${sources}`,
    summary: `Pinned ${sources} at their newest releases.`, token, env: pushEnv(token)});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'stage') await stage();
  else if (process.argv[2] === 'bump') await bump();
  else throw new Error('dependencies.mjs stage|bump');
}
