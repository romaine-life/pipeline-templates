import fs from 'node:fs';
import {api, post, request, run} from './lib.mjs';
import {queuePR} from './queue.mjs';

// A take-up of newer dependencies: the files an update rewrote, proposed as one PR to
// merge-queue. An open take-up with the same contents is queued again instead of opening
// another, and older ones are closed as superseded. strip-owner follows a take-up by its
// branch name, deps/<run> (agent-tools pr/deliver.go).
export async function proposeDependencies({files, title, message, summary, token, env}) {
  const previous=[];
  for (let page=1;;page++) {
    const batch=await request(`${api()}/pulls?state=open&limit=50&page=${page}`,{token});
    previous.push(...batch.filter(pr=>/^deps\/\d+$/.test(pr.head.ref)));
    if (batch.length<50) break;
  }
  for (const pr of previous) {
    let same=true;
    for (const file of files) {
      const content=await request(`${api()}/contents/${file}?ref=${encodeURIComponent(pr.head.sha)}`,{token,allow404:true});
      const old=content ? Buffer.from(content.content,'base64') : null;
      const current=fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (old === null ? current !== null : !current || !old.equals(current)) same=false;
    }
    if (same) { await queuePR(pr.number,{token}); console.log(`Queued: ${pr.html_url}`); return pr; }
  }
  const branch = `deps/${process.env.GITHUB_RUN_ID}`;
  run('git', ['checkout', '-b', branch]);
  run('git', ['add', '--', ...files]);
  run('git', ['-c', 'user.name=forgejo-actions', '-c', 'user.email=forgejo-actions@noreply.romaine.life', 'commit', '-m', message]);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {env});
  const pr = await post(`${api()}/pulls`, {base: process.env.DEFAULT_BRANCH, head: branch, title,
    body: `${summary} https://openproject.home.romaine.life/wp/PIPT-12`},{token});
  await queuePR(pr.number,{token});
  for (const old of previous) {
    await request(`${api()}/pulls/${old.number}`,{token,method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state:'closed',body:`${old.body || ''}\n\nSuperseded by ${pr.html_url}.`})});
    await request(`${api()}/branches/${encodeURIComponent(old.head.ref)}`,{token,method:'DELETE'});
  }
  console.log(pr.html_url);
  return pr;
}

// git's credential for pushing the take-up branch, kept out of its process arguments.
export function pushEnv(token, base = process.env) {
  return {...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
}
