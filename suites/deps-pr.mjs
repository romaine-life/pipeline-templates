import fs from 'node:fs';
import {api, post, request, run} from './lib.mjs';
import {queuePR} from './queue.mjs';

// A take-up of newer dependencies: the files an update rewrote, proposed as one PR to
// merge-queue. An open take-up with the same contents is queued again instead of opening
// another, unless Forgejo says it doesn't merge into the default branch: one cut from a
// main another take-up has since moved conflicts on the same go.mod lines, and merge-queue
// would only stop it again (ROLAT-3). Older ones are closed as superseded. strip-owner
// follows the open take-up (agent-tools pr/deliver.go).
export async function proposeDependencies({files, title, message, summary, token, env},
  {call = request, send = post, exec = run, queue = queuePR, read = fs.readFileSync, exists = fs.existsSync} = {}) {
  const previous=[];
  for (let page=1;;page++) {
    const batch=await call(`${api()}/pulls?state=open&limit=50&page=${page}`,{token});
    previous.push(...batch.filter(pr=>/^deps\/\d+$/.test(pr.head.ref)));
    if (batch.length<50) break;
  }
  for (const pr of previous) {
    if (pr.mergeable === false) continue;
    let same=true;
    for (const file of files) {
      const content=await call(`${api()}/contents/${file}?ref=${encodeURIComponent(pr.head.sha)}`,{token,allow404:true});
      const old=content ? Buffer.from(content.content,'base64') : null;
      const current=exists(file) ? read(file) : null;
      if (old === null ? current !== null : !current || !old.equals(current)) same=false;
    }
    if (same) { await queue(pr.number,{token}); console.log(`Queued: ${pr.html_url}`); return pr; }
  }
  const branch = `deps/${process.env.GITHUB_RUN_ID}`;
  exec('git', ['checkout', '-b', branch]);
  exec('git', ['add', '--', ...files]);
  exec('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', message]);
  exec('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await send(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch, title,
    body: `${summary} https://openproject.home.romaine.life/wp/PIPT-12`},{token});
  await queue(pr.number,{token});
  for (const old of previous) {
    await call(`${api()}/pulls/${old.number}`,{token,method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state:'closed',body:`${old.body || ''}\n\nSuperseded by ${pr.html_url}.`})});
    await call(`${api()}/branches/${encodeURIComponent(old.head.ref)}`,{token,method:'DELETE'});
  }
  console.log(pr.html_url);
  return pr;
}

// git's credential for pushing the take-up branch, kept out of its process arguments.
export function pushEnv(token, base = process.env) {
  return {...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
}
