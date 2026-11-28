import fs from 'node:fs';
import {queuePR} from '../queue.mjs';
import {api, post, request, run, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import {updatePin} from './pin-fields.mjs';
import {clusterImages, workPackage} from '../layout.mjs';
requirePublish();
const cfg = (process.argv[2] === 'web' ? config().web : config().cluster) || {};
// Each image the release published (or carried on), one pin a line in .ci-image-pin, the
// repository's own first (image.mjs), each moved in the file that pins it, in one PR.
const images = clusterImages(cfg);
for (const section of images) if (!section.pinFile) throw new Error(`no single tracked YAML file pins ${section.image} by digest`);
const lines = fs.readFileSync('.ci-image-pin', 'utf8').trim().split(/\r?\n/);
if (lines.length !== images.length || lines.some((line, index) => !line.startsWith(`${images[index].image}:`))) throw new Error(`.ci-image-pin names ${lines.join(', ')}, not ${images.map(section => section.image).join(', ')}`);
const token = process.env.PIN_TOKEN;
if (!token) throw new Error('missing PIN_TOKEN, a Forgejo write token from actions/forgejo-token');
const env = {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
const branch = `ci-pin/${process.env.VERSION}`;
// Releases compare by their numbers, so v0.1.10 is newer than v0.1.9.
const newer = (a, b) => a.localeCompare(b, undefined, {numeric: true}) > 0;
const open = [];
let mine = null;
for (let page = 1;; page++) {
  const batch = await request(`${api()}/pulls?state=open&limit=50&page=${page}`, {token});
  open.push(...batch.filter(pr => pr.head.ref.startsWith('ci-pin/') && pr.head.ref !== branch));
  mine ||= batch.find(pr => pr.head.ref === branch);
  if (batch.length < 50) break;
}
// A rerun of a release whose pin is already proposed (release.mjs scope) leaves that PR be.
if (mine) { console.log(`${mine.html_url} already pins this release`); process.exit(0); }
// A newer release's pin is already open: it carries a newer image than this one would.
const ahead = open.find(pr => newer(pr.head.ref.slice('ci-pin/'.length), process.env.VERSION));
if (ahead) { console.log(`${ahead.html_url} pins a newer release`); process.exit(0); }
// The pin is made on the default branch as it is now, not on the release commit: another
// release's pin may have merged since, and a branch from the release commit would conflict
// with it (PIPT-14).
run('git', ['fetch', '--no-tags', '--depth=1', 'origin', process.env.DEFAULT_BRANCH], {env});
run('git', ['checkout', '-B', branch, 'FETCH_HEAD']);
// The PR this release's commit merged (none for a direct push): the pin PR links its work
// package, and a pin field may name it.
const commit = process.env.SOURCE_SHA || process.env.GITHUB_SHA;
const merged = await request(`${api()}/commits/${commit}/pull`, {token: process.env.TOKEN, allow404: true});
const files = [...new Set(images.map(section => section.pinFile))], originals = Object.fromEntries(files.map(file => [file, fs.readFileSync(file, 'utf8')]));
const updates = {...originals};
for (const [index, section] of images.entries()) updates[section.pinFile] = updatePin(updates[section.pinFile], section, lines[index], {pr: merged});
const changed = files.filter(file => updates[file] !== originals[file]);
if (changed.length) {
  for (const file of changed) fs.writeFileSync(file, updates[file]);
  run('git', ['add', '--', ...changed]);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', `Pin ${cfg.image} ${process.env.VERSION}`]);
  // The branch is this release's alone: one a run that stopped before its PR left is replaced.
  run('git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await post(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch,
    title: `Pin ${cfg.image} ${process.env.VERSION}`, body: [`Published image${lines.length > 1 ? 's' : ''} ${lines.join(', ')}.`, workPackage(merged?.body)].filter(Boolean).join(' ')}, {token});
  await queuePR(pr.number,{token});
  // An older release's pin still open would put an older image back: this one supersedes it.
  for (const old of open) {
    await request(`${api()}/pulls/${old.number}`, {token, method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({state: 'closed', body: `${old.body || ''}\n\nSuperseded by ${pr.html_url}.`})});
    await request(`${api()}/branches/${encodeURIComponent(old.head.ref)}`, {token, method: 'DELETE'});
  }
  console.log(pr.html_url);
}
