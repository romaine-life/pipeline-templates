import {api,post,request} from './lib.mjs';

export async function armAutoMerge(number,sha,{token,url=api(),get=request,send=post}={}) {
  if(!token)throw new Error('auto-merge requires PIPELINE_DISPATCH_TOKEN');
  if(!Number.isSafeInteger(number) || number<1 || !/^[0-9a-f]{40,64}$/.test(sha || ''))throw new Error('auto-merge requires the PR number and pushed commit');
  const route=`${url}/pulls/${number}/merge`,body={Do:'squash',merge_when_checks_succeed:true,delete_branch_after_merge:true,head_commit_id:sha};
  try {await send(route,body,{token});}
  catch(error) {
    if(!/HTTP 409\b/.test(error.message))throw error;
    const pr=await get(`${url}/pulls/${number}`,{token});
    if(pr.state!=='open' || pr.head.sha!==sha)throw error;
    await get(route,{token,method:'DELETE'});
    await send(route,body,{token});
  }
}
