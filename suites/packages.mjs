// npm packages on Forgejo's registry (PIPT-32). A repository whose root package.json names a
// package in its owner's scope (`@<owner>/<name>`, not private) publishes it with each release,
// at the release's version; one that uses a package names the registry and the sign-in in an
// .npmrc beside its package.json:
//
//   @romaine-life:registry=https://forgejo.romaine.life/api/packages/romaine-life/npm/
//   //forgejo.romaine.life/api/packages/romaine-life/npm/:_authToken=${FORGEJO_PACKAGES_TOKEN}
//
// No credential is stored anywhere: Forgejo's authorized integrations (nelsong6/forgejo
// README, Package sign-in) take a CI job's own short-lived token, and on a home PC one OpenBao
// signs for the PC's role forgejo-packages. A new release of a package proposes it to every
// repository that uses it, as a take-up PR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture, post, request, requirePublish, run, tracked} from './lib.mjs';
import {currentRepository, fleet} from './config.mjs';
import {proposeDependencies, pushEnv} from './deps-pr.mjs';

const server = () => process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life';
export const registry = (owner, base = server()) => `${base}/api/packages/${owner}/npm/`;
// The integrations' audiences, which Forgejo made (nelsong6/forgejo README).
export const audiences = {read: 'u:1:5a0cac97-e87c-4848-95ba-6ec9fa7af23f', publish: 'u:1:d64318b1-a427-4448-b934-29b7d22c165f'};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

// A CI job's own token for an audience (the job sets enable-openid-connect).
export {jobToken} from './forgejo-token.mjs';
import {jobToken} from './forgejo-token.mjs';

// A token that reads packages: the job's in CI; on a home PC, OpenBao's for its role.
export async function readToken(env = process.env) {
  if (env.GITHUB_ACTIONS) return jobToken(audiences.read, env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packages-'));
  try {
    run('romaine-auth', ['home-token', '--role', 'forgejo-packages', '--out', path.join(dir, 'token.json')]);
    return JSON.parse(fs.readFileSync(path.join(dir, 'token.json'), 'utf8')).token;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// Whether the repository reads packages from Forgejo: one of its .npmrc files signs in for them.
export const usesPackages = (files = tracked()) => files.some(file => path.posix.basename(file) === '.npmrc' && fs.existsSync(file)
  && fs.readFileSync(file, 'utf8').includes('${FORGEJO_PACKAGES_TOKEN'));

// The suite action, once per job: FORGEJO_PACKAGES_TOKEN for npm and Docker builds, when the
// repository reads packages and the job can sign in.
export async function signIn(env = process.env) {
  if (!usesPackages()) return;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) { console.log('Not signed in for packages: this job has no enable-openid-connect'); return; }
  const token = await jobToken(audiences.read, env);
  console.log(`::add-mask::${token}`);
  fs.appendFileSync(env.GITHUB_ENV, `FORGEJO_PACKAGES_TOKEN=${token}\n`);
}

// The package the repository's root package.json publishes, if any.
export function ownPackage(owner = currentRepository().split('/')[0], read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) {
  const text = read('package.json');
  if (!text) return null;
  const manifest = JSON.parse(text);
  if (manifest.private || !manifest.name?.startsWith('@')) return null;
  if (!manifest.name.startsWith(`@${owner}/`)) throw new Error(`package.json names ${manifest.name}, outside its owner's scope @${owner}`);
  return manifest;
}

// The release's version as npm's: v0.1.12 -> 0.1.12.
export function packageVersion(tag) {
  const version = String(tag).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release ${tag} isn't an npm version`);
  return version;
}

async function download(url, token) {
  const response = await fetch(url, {headers: {Authorization: `token ${token}`}, signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Publishes the release's package: the files its package.json lists, from the release's commit
// with the release's assets in dist/, at the release's version. A version already published
// is left alone, so a rerun publishes nothing twice.
export async function publishPackage({tag = process.env.VERSION, repository = currentRepository(), token = process.env.DISPATCH_TOKEN} = {}) {
  const owner = repository.split('/')[0], manifest = ownPackage(owner);
  if (!manifest) return null;
  const version = packageVersion(tag), url = registry(owner);
  const auth = await jobToken(audiences.publish);
  const published = await fetch(`${url}${manifest.name.replace('/', '%2f')}`, {headers: {Authorization: `Bearer ${auth}`}, signal: AbortSignal.timeout(30000)});
  if (published.ok && (await published.json()).versions?.[version]) { console.log(`${manifest.name}@${version} is already published`); return manifest.name; }
  if ((manifest.files || []).some(entry => entry === 'dist' || entry.startsWith('dist/'))) {
    if (!token) throw new Error('reading the release assets requires a Forgejo token from actions/forgejo-token');
    const release = await request(`${server()}/api/v1/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {token});
    fs.mkdirSync('dist', {recursive: true});
    for (const asset of release.assets) fs.writeFileSync(path.join('dist', asset.name), await download(asset.browser_download_url, token));
  }
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'publish-'));
  try {
    const rc = path.join(dir, '.npmrc');
    fs.writeFileSync(rc, `${url.replace(/^https?:/, '')}:_authToken=${auth}\n`, {mode: 0o600});
    run(npm, ['version', version, '--no-git-tag-version', '--allow-same-version'], {shell});
    run(npm, ['publish', '--registry', url, '--userconfig', rc, '--ignore-scripts'], {shell});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  console.log(`Published ${manifest.name}@${version}`);
  return manifest.name;
}

const dependsOn = (manifest, name) => [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(set => set && name in set);

// The repositories whose package.json files (outside node_modules) use a package, each with
// the take-up workflow its suites carry.
export async function consumers(name, {token, repos = fleet(), base = server()} = {}) {
  const found = [];
  for (const [repository, entry] of Object.entries(repos)) {
    const workflow = entry.suites?.includes('web-app') ? 'web-app/dependencies.yml' : entry.suites?.includes('release') ? 'release/dependencies.yml' : null;
    const repo = await request(`${base}/api/v1/repos/${repository}`, {token, allow404: true});
    if (!repo || repo.empty || repo.archived) continue;
    const files = [];
    for (let page = 1; ; page++) {
      const tree = await request(`${base}/api/v1/repos/${repository}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=true&per_page=10000&page=${page}`, {token});
      files.push(...(tree.tree || []).filter(item => item.type === 'blob' && /(^|\/)package\.json$/.test(item.path) && !item.path.split('/').includes('node_modules')).map(item => item.path));
      if (!tree.truncated || (tree.tree || []).length === 0) break;
    }
    for (const file of files) {
      const text = await request(`${base}/api/v1/repos/${repository}/raw/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.default_branch)}`, {token, text: true});
      let manifest;
      try { manifest = JSON.parse(text); } catch { continue; }
      if (!dependsOn(manifest, name)) continue;
      if (!workflow) throw new Error(`${repository} uses ${name} but has neither the web-app nor the release suite to take it up`);
      found.push({repository, workflow, branch: repo.default_branch});
      break;
    }
  }
  return found;
}

// A published package's take-up, dispatched to each repository that uses it.
export async function dispatchConsumers(name, token = process.env.DISPATCH_TOKEN) {
  if (!token) throw new Error('dispatching take-ups requires a Forgejo write token from actions/forgejo-token');
  for (const target of await consumers(name, {token})) {
    await post(`${server()}/api/v1/repos/${target.repository}/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`, {ref: target.branch}, {token});
    console.log(`${target.repository}: ${target.workflow} takes up ${name}`);
  }
}

// The packages a package directory gets from Forgejo: its package.json's own dependencies
// that its lock resolves from Forgejo's registry.
export function forgejoDependencies(dir, base = server()) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return [];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lockFile = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lockFile)) return [];
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const names = new Set([manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].flatMap(set => Object.keys(set || {})));
  return [...names].filter(name => lock.packages?.[`node_modules/${name}`]?.resolved?.startsWith(`${base}/api/packages/`)).sort();
}

// The packages whose pinned version a take-up moved, as `name old -> new`, from each
// package.json's dependencies before and after.
export function moved(before, after) {
  const pins = manifest => Object.assign({}, manifest.optionalDependencies, manifest.devDependencies, manifest.dependencies);
  const result = new Set();
  for (const [file, old] of Object.entries(before)) {
    const was = pins(old), now = pins(after[file]);
    for (const name of Object.keys(now)) if (name in was && was[name] !== now[name]) result.add(`${name} ${was[name]} -> ${now[name]}`);
  }
  return [...result].sort();
}

// Takes the newest version of every package the repository gets from Forgejo, each pinned
// exactly, and proposes it as one take-up PR (web-app/dependencies.yml, release/dependencies.yml).
export async function takeUp() {
  requirePublish();
  const token = process.env.TOKEN;
  if (!token) throw new Error('missing TOKEN, a Forgejo write token from actions/forgejo-token');
  process.env.FORGEJO_PACKAGES_TOKEN ??= await readToken();
  const files = [], before = {};
  for (const file of tracked().filter(f => path.posix.basename(f) === 'package.json' && !f.split('/').includes('node_modules'))) {
    const dir = path.posix.dirname(file), names = forgejoDependencies(dir);
    if (!names.length) continue;
    before[file] = JSON.parse(fs.readFileSync(file, 'utf8'));
    run(npm, ['install', '--package-lock-only', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', ...names.map(name => `${name}@latest`)], {cwd: dir, shell});
    files.push(file, path.posix.join(dir, 'package-lock.json'));
  }
  if (!files.length) throw new Error('no package.json here takes a package from Forgejo');
  const changed = capture('git', ['status', '--porcelain', '--', ...files]);
  if (!changed) { console.log('Every package from Forgejo is current'); return; }
  const names = moved(before, Object.fromEntries(Object.keys(before).map(file => [file, JSON.parse(fs.readFileSync(file, 'utf8'))]))).join(', ') || 'the packages from Forgejo';
  await proposeDependencies({files, title: 'Take newer packages', message: `Take the newest ${names}`,
    summary: `Takes the newest ${names}.`, token, env: pushEnv(token)});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'sign-in') await signIn();
  else if (process.argv[2] === 'take-up') await takeUp();
  else throw new Error('packages.mjs sign-in|take-up');
}
