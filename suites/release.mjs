import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {api, post, request, tracked, requirePublish, capture, output, hash, templates} from './lib.mjs';
import {config} from './config.mjs';
import {inputs, relevant} from './input-patterns.mjs';
import {embedded, dockerSources, docLinks} from './dependencies.mjs';
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
export async function releaseScope(suite) {
  const cfg = config();
  if (suite === 'cluster-service' && cfg.cluster?.build === false) { output('build', false); return; }
  if (suite === 'web-app' && !cfg.web?.image && !cfg.web?.staticApp || suite === 'docs' && !cfg.docs?.release) { output('build', false); return; }
  const latest = await request(`${api()}/releases/latest`, {allow404: true});
  if (!latest) { output('build', true); return; }
  const base = capture('git', ['rev-parse', '--verify', `refs/tags/${latest.tag_name}^{commit}`]);
  const files = capture('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD']).split('\0').filter(Boolean);
  const job = suite === 'cluster-service' ? 'cluster-service.image' : suite === 'web-app' ? (cfg.web?.staticApp ? 'web-app.test' : 'web-app.image') : suite === 'docs' ? 'docs.validate' : 'release.build';
  const kinds=cfg.release?.toolchains || [];
  const extra = suite === 'docs' ? docLinks() : ['web-app','cluster-service'].includes(suite) && fs.existsSync('Dockerfile') ? dockerSources(fs.readFileSync('Dockerfile','utf8')) : kinds.flatMap(kind=>embedded()[kind] || []);
  cfg.inputs = {...cfg.inputs, [job]: [...(cfg.inputs?.[job] || []), ...extra, ...(cfg.release?.dependencies || []).flatMap(d=>d.lock ? [d.lock] : []),...(cfg.release?.archives || []).flatMap(a=>a.sources),...(cfg.inputs?.['release.package'] || [])]};
  output('build', relevant(files, job, cfg));
}
export async function sourceRelease() {
  requirePublish();
  const file = path.resolve('dist/source.zip');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  capture('git', ['archive', '--format=zip', '-o', file, 'HEAD']);
  await stage({files: [file]});
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
    const assets = config().release?.assets || fs.readdirSync('dist').map(f => `dist/${f}`);
    await stage({files: assets});
  } else throw new Error('release.mjs scope <suite>|source|stage|publish');
}
