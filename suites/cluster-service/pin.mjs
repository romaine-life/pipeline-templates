import fs from 'node:fs';
import {queuePR} from '../queue.mjs';
import {api, post, request, run, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import {updatePin, prSources} from './pin-fields.mjs';
requirePublish();
const cfg = (process.argv[2] === 'web' ? config().web : config().cluster) || {};
if (!cfg.pinFile || !/^https:\/\/openproject\.home\.romaine\.life\/wp\/[A-Z][A-Z0-9]*-\d+$/.test(cfg.workPackage || '')) throw new Error('cluster pinFile and workPackage are required');
const pin = fs.readFileSync('.ci-image-pin', 'utf8').trim();
const original = fs.readFileSync(cfg.pinFile, 'utf8');
// The PR this release's commit merged, for a pin field that names it (none for a direct push).
const commit = process.env.SOURCE_SHA || process.env.GITHUB_SHA;
const pr = Object.values(cfg.pinFields || {}).some(source => prSources.includes(source))
  ? await request(`${api()}/commits/${commit}/pull`, {token: process.env.TOKEN, allow404: true}) : null;
const updated=updatePin(original,cfg,pin,{pr});
if (updated !== original) {
  const branch = `ci-pin/${process.env.VERSION}`;
  const token = process.env.PIN_TOKEN;
  if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN for pin CI');
  run('git', ['checkout', '-b', branch]);
  fs.writeFileSync(cfg.pinFile, updated);
  run('git', ['add', '--', cfg.pinFile]);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', `Pin ${cfg.image} ${process.env.VERSION}`]);
  const env = {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await post(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch,
    title: `Pin ${cfg.image} ${process.env.VERSION}`, body: `Published image ${pin}. ${cfg.workPackage}`}, {token});
  await queuePR(pr.number,{token});
  console.log(pr.html_url);
}
