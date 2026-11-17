import fs from 'node:fs';
import {queuePR} from '../queue.mjs';
import {api, post, request, run, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import {updatePin, prSources} from './pin-fields.mjs';
requirePublish();
const cfg = (process.argv[2] === 'web' ? config().web : config().cluster) || {};
if (!cfg.pinFile || !/^https:\/\/openproject\.home\.romaine\.life\/wp\/[A-Z][A-Z0-9]*-\d+$/.test(cfg.workPackage || '')) throw new Error('cluster pinFile and workPackage are required');
const pin = fs.readFileSync('.ci-image-pin', 'utf8').trim();
const token = process.env.PIN_TOKEN;
if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN for pin CI');
const env = {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
const branch = `ci-pin/${process.env.VERSION}`;
// Releases compare by their numbers, so v0.1.10 is newer than v0.1.9.
const newer = (a, b) => a.localeCompare(b, undefined, {numeric: true}) > 0;
const open = [];
for (let page = 1;; page++) {
  const batch = await request(`${api()}/pulls?state=open&limit=50&page=${page}`, {token});
  open.push(...batch.filter(pr => pr.head.ref.startsWith('ci-pin/') && pr.head.ref !== branch));
  if (batch.length < 50) break;
}
// A newer release's pin is already open: it carries a newer image than this one would.
const ahead = open.find(pr => newer(pr.head.ref.slice('ci-pin/'.length), process.env.VERSION));
if (ahead) { console.log(`${ahead.html_url} pins a newer release`); process.exit(0); }
// The pin is made on the default branch as it is now, not on the release commit: another
// release's pin may have merged since, and a branch from the release commit would conflict
// with it (PIPT-14).
run('git', ['fetch', '--no-tags', '--depth=1', 'origin', process.env.DEFAULT_BRANCH], {env});
run('git', ['checkout', '-B', branch, 'FETCH_HEAD']);
const original = fs.readFileSync(cfg.pinFile, 'utf8');
// The PR this release's commit merged, for a pin field that names it (none for a direct push).
const commit = process.env.SOURCE_SHA || process.env.GITHUB_SHA;
const merged = Object.values(cfg.pinFields || {}).some(source => prSources.includes(source))
  ? await request(`${api()}/commits/${commit}/pull`, {token: process.env.TOKEN, allow404: true}) : null;
const updated = updatePin(original, cfg, pin, {pr: merged});
if (updated !== original) {
  fs.writeFileSync(cfg.pinFile, updated);
  run('git', ['add', '--', cfg.pinFile]);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', `Pin ${cfg.image} ${process.env.VERSION}`]);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await post(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch,
    title: `Pin ${cfg.image} ${process.env.VERSION}`, body: `Published image ${pin}. ${cfg.workPackage}`}, {token});
  await queuePR(pr.number,{token});
  // An older release's pin still open would put an older image back: this one supersedes it.
  for (const old of open) {
    await request(`${api()}/pulls/${old.number}`, {token, method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({state: 'closed', body: `${old.body || ''}\n\nSuperseded by ${pr.html_url}.`})});
    await request(`${api()}/branches/${encodeURIComponent(old.head.ref)}`, {token, method: 'DELETE'});
  }
  console.log(pr.html_url);
}
