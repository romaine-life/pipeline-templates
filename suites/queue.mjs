import {api,post,request} from './lib.mjs';

// merge-queue lands a PR that carries the repository's `queue` label: it brings the branch
// up to date with its base, which a branch protection blocking outdated branches needs,
// and merges once CI passes. A repository without the label gets it.
export async function queuePR(number,{token,url=api(),get=request,send=post}={}) {
  if(!token)throw new Error('queueing a PR requires PIPELINE_DISPATCH_TOKEN');
  if(!Number.isSafeInteger(number) || number<1)throw new Error('queueing requires the PR number');
  let label;
  for(let page=1;;page++) {
    const batch=await get(`${url}/labels?limit=50&page=${page}`,{token});
    label=batch.find(l=>l.name==='queue');
    if(label || batch.length<50)break;
  }
  label??=await send(`${url}/labels`,{name:'queue',color:'0e8a16',description:'merge-queue lands it once CI passes'},{token});
  await send(`${url}/issues/${number}/labels`,{labels:[label.id]},{token});
}
