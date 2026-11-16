import {api, capture, post, request, run, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import fs from 'node:fs';
import {queuePR} from '../queue.mjs';
requirePublish();
const modules = config().go?.dependencies || [];
if (!modules.length || modules.some(m => !/^github\.com\/romaine-life\/[\w.-]+(?:\/[\w.-]+)*$/.test(m))) throw new Error('go.dependencies must name romaine-life modules');
const token=process.env.TOKEN;
if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN');
const env = {...process.env, GOPRIVATE: 'github.com/romaine-life/*', GONOSUMDB: 'github.com/romaine-life/*',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${process.env.GITHUB_SERVER_URL}/romaine-life/.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/romaine-life/',
  GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
run('go', ['get', '-p', '4', ...modules.map(m => `${m}@latest`)], {env});
run('go', ['mod', 'tidy'], {env});
if (capture('git', ['diff', '--name-only', '--', 'go.mod', 'go.sum'])) {
  const previous=[];
  for (let page=1;;page++) {
    const batch=await request(`${api()}/pulls?state=open&limit=50&page=${page}`,{token});
    previous.push(...batch.filter(pr=>pr.head.ref.startsWith('deps/ci-suite-')));
    if (batch.length<50) break;
  }
  for (const pr of previous) {
    let same=true;
    for (const file of ['go.mod','go.sum']) {
      const content=await request(`${api()}/contents/${file}?ref=${encodeURIComponent(pr.head.sha)}`,{token,allow404:true});
      const old=content ? Buffer.from(content.content,'base64') : null;
      const current=fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (old === null ? current !== null : !current || !old.equals(current)) same=false;
    }
    if (same) { await queuePR(pr.number,{token});console.log(`Queued: ${pr.html_url}`); process.exit(0); }
  }
  const branch = `deps/ci-suite-${process.env.GITHUB_RUN_ID}`;
  run('git', ['checkout', '-b', branch]);
  run('git', ['add', 'go.mod', 'go.sum']);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', `Take ${modules.join(', ')}`]);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await post(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch, title: 'Take Go dependencies',
    body: `Updated ${modules.join(', ')}. https://openproject.home.romaine.life/wp/PIPT-12`},{token});
  await queuePR(pr.number,{token});
  for (const old of previous) {
    await request(`${api()}/pulls/${old.number}`,{token,method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state:'closed',body:`${old.body || ''}\n\nSuperseded by ${pr.html_url}.`})});
    await request(`${api()}/branches/${encodeURIComponent(old.head.ref)}`,{token,method:'DELETE'});
  }
  console.log(pr.html_url);
}
