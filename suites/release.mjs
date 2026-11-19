import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {api, post, request, tracked, requirePublish, capture, output, hash, templates} from './lib.mjs';
import {config} from './config.mjs';
import {relevant, matches} from './input-patterns.mjs';
import {imageInputs} from './dependencies.mjs';
import {found} from './fingerprints.mjs';
import {zipDirectory} from './release/zip.mjs';
import {dispatchConsumers, publishPackage} from './packages.mjs';
import {dispatchConsumers as dispatchModuleConsumers, ownModule} from './go/modules.mjs';
const require = createRequire(import.meta.url);

export async function stage({url = api(), tag = process.env.VERSION, sha = process.env.GITHUB_SHA, files, token = process.env.TOKEN}) {
  if (!/^[\w.+-]+$/.test(tag || '')) throw new Error('invalid release version');
  if (!files.length) throw new Error('release has no assets');
  for (const file of files) if (!fs.statSync(file).size) throw new Error(`empty asset: ${file}`);
  let release = await request(`${url}/releases/tags/${encodeURIComponent(tag)}`, {token, allow404: true});
  const manifest = files.map(file => ({name: path.basename(file), size: fs.statSync(file).size, sha256: hash(fs.readFileSync(file))}));
  if (new Set(manifest.map(f => f.name)).size !== manifest.length) throw new Error('release asset basenames must be unique');
  const body = `Built from ${sha}.\n\n${JSON.stringify({sha, files: manifest})}`;
  if (release && release.target_commitish !== sha && release.body !== body) throw new Error('existing release does not belong to this commit');
  if (release && !release.draft) {
    if (release.body !== body || manifest.some(f => !release.assets?.some(a => a.name === f.name && a.size === f.size))) throw new Error('published release is immutable and differs from this build');
    return release;
  }
  if (!release) release = await post(`${url}/releases`, {tag_name: tag, target_commitish: sha, name: tag, body, draft: true}, {token});
  else {
    for (const asset of release.assets || []) await request(`${url}/releases/${release.id}/assets/${asset.id}`, {token, method: 'DELETE'});
    await request(`${url}/releases/${release.id}`, {token, method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({body})});
  }
  for (const file of files) {
    const form = new FormData();
    form.append('attachment', new Blob([fs.readFileSync(file)]), path.basename(file));
    await request(`${url}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(file))}`, {method: 'POST', body: form, token});
  }
  return release;
}
// A directory staged for release (a static site's build, dist/<package>/) is published as one
// archive beside it, <name>.zip.
export function stagedFiles(files) {
  return files.map(file => {
    if (!fs.statSync(file).isDirectory()) return file;
    const archive = `${file.replace(/[\/]+$/, '')}.zip`;
    fs.writeFileSync(archive, zipDirectory(file));
    return archive;
  });
}
export async function releaseScope(suite) {
  const cfg = config();
  if (suite === 'cluster-service' && cfg.cluster?.build === false) { output('build', false); return; }
  if (suite === 'web-app' && !cfg.web?.image && !cfg.web?.staticApp || suite === 'docs' && !cfg.docs?.release) { output('build', false); return; }
  // A release started by hand (strip-owner, with no callback inputs) releases the branch's
  // head whatever changed: it replaces a published release that is unusable, as at's
  // v0.1.10 and v0.1.11 were, signed without their tag (PIPT-37).
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') { output('build', true); return; }
  const latest = await request(`${api()}/releases/latest`, {allow404: true});
  if (!latest) { output('build', true); return; }
  const base = capture('git', ['rev-parse', '--verify', `refs/tags/${latest.tag_name}^{commit}`]);
  const files = capture('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD']).split('\0').filter(Boolean);
  const job = suite === 'cluster-service' ? 'cluster-service.image' : suite === 'web-app' ? (cfg.web?.staticApp ? 'release.build' : 'web-app.image') : suite === 'docs' ? 'docs.validate' : 'release.build';
  output('build', relevant(files, job, await found(job, cfg)));
  if (suite === 'release' && cfg.release?.image === 'cluster') output('image-build', joinedImageChanged(cfg.cluster));
}
// The image the pin file runs (`<image>:<tag>@sha256:<digest>`), when it names exactly one.
export function pinnedImage(section) {
  if (!section.pinFile) return null;
  const escaped = section.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pins = [...new Set(fs.readFileSync(section.pinFile, 'utf8').match(new RegExp(`${escaped}:[\\w.+-]+@sha256:[0-9a-f]{64}`, 'g')) || [])];
  return pins.length === 1 ? pins[0] : null;
}
// A joined cluster image is built again only when its inputs changed since the release that
// built the pinned one; otherwise the release carries that image on, and its pin PR moves only
// the release's fields, so a release doesn't restart the pod (PIPT-12, SPT-4).
export function joinedImageChanged(section) {
  const pin = pinnedImage(section);
  if (!pin) return true;
  const tag = pin.slice(section.image.length + 1).split('@')[0];
  let base;
  try { base = capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]); } catch { return true; }
  const files = capture('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD']).split('\0').filter(Boolean);
  const patterns = imageInputs(section);
  return files.some(file => patterns.some(pattern => matches(file, pattern)));
}
export async function sourceRelease() {
  requirePublish();
  const file = path.resolve('dist/source.zip');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  capture('git', ['archive', '--format=zip', '-o', file, 'HEAD']);
  await stage({files: [file, ...(fs.existsSync('dist/image.txt') ? ['dist/image.txt'] : [])]});
}
export async function publish() {
  requirePublish();
  const release = await request(`${api()}/releases/tags/${encodeURIComponent(process.env.VERSION)}`);
  if (release.prerelease || !release.assets?.length) throw new Error('draft has no stable assets');
  if (release.draft) await request(`${api()}/releases/${release.id}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({draft: false})});
  await require(path.join(templates, 'actions/prune-releases/prune.js')).prune({api: api(), token: process.env.TOKEN});
  await dispatch();
}
export async function dispatch() {
  requirePublish();
  // The release's npm package, when its package.json names one, then a take-up to every
  // repository that uses it (packages.mjs).
  const name = await publishPackage();
  if (name) await dispatchConsumers(name);
  // The release's Go module, when go.mod names one, then a take-up to every repository whose
  // go.mod requires it (go/modules.mjs).
  const module = ownModule();
  if (module) await dispatchModuleConsumers(module);
  if (config().release?.mirror) {
    if (!process.env.DISPATCH_TOKEN) throw new Error('mirror sync requires PIPELINE_DISPATCH_TOKEN');
    const options={token:process.env.DISPATCH_TOKEN};
    const mirrors=await request(`${api()}/push_mirrors`,options);
    if (mirrors.length) await post(`${api()}/push_mirrors-sync`,{},options);
  }
  for (const target of config().release?.dispatch || []) {
    const token=process.env.DISPATCH_TOKEN;
    if (!token) throw new Error('downstream dispatch requires PIPELINE_DISPATCH_TOKEN');
    const url=`${process.env.GITHUB_SERVER_URL}/api/v1/repos/${target.repository}`;
    const repo=await request(url,{token});
    await post(`${url}/actions/workflows/${encodeURIComponent(target.workflow || 'go/dependencies.yml')}/dispatches`,
      {ref:repo.default_branch},{token});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'scope') await releaseScope(process.argv[3]);
  else if (mode === 'source') await sourceRelease();
  else if (mode === 'publish') await publish();
  else if (mode === 'dispatch') await dispatch();
  else if (mode === 'image') {
    requirePublish();
    fs.mkdirSync('dist', {recursive: true});
    fs.copyFileSync('.ci-image-pin', 'dist/image.txt');
    await stage({files: ['dist/image.txt']});
    await publish();
  }
  else if (mode === 'stage') {
    requirePublish();
    await stage({files: stagedFiles(fs.readdirSync('dist').map(f => `dist/${f}`))});
  } else throw new Error('release.mjs scope <suite>|source|stage|publish');
}
