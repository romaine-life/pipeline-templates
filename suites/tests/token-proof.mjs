import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {api,request,post,output} from '../lib.mjs';
import {armAutoMerge} from '../auto-merge.mjs';

const token=process.env.PIN_TOKEN,actions=process.env.TOKEN;
const base=`${process.env.GITHUB_SERVER_URL}/api/v1`;
async function denied(url,options={}) {
  await assert.rejects(request(url,{...options,token:actions}),/HTTP 404\b/);
}
export async function cleanup(file) {
  if(!file || !fs.existsSync(file))return;
  const owned=JSON.parse(fs.readFileSync(file,'utf8'));
  if(owned.repo!=='romaine-life/pipeline-token-proof' || !/^pipt12-token-proof-\d+-\d+$/.test(owned.branch))throw new Error('invalid token proof cleanup');
  const url=`${base}/repos/${owned.repo}`,repo=await request(url,{token,allow404:true});
  if(repo) {
    if(repo.full_name!==owned.repo || (owned.id && repo.id!==owned.id))throw new Error('scratch repository ownership changed');
    if(owned.pr)await request(`${url}/pulls/${owned.pr}/merge`,{token,method:'DELETE',allow404:true});
    if(owned.pr)await request(`${url}/pulls/${owned.pr}`,{token,method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'closed'})});
    if(await request(`${url}/branches/${owned.branch}`,{token,allow404:true}))await request(`${url}/branches/${owned.branch}`,{token,method:'DELETE'});
  }
  fs.rmSync(file,{force:true});
}
if(process.argv[2]==='cleanup')await cleanup(process.env.CI_TOKEN_PROOF_STATE);
else {
  assert.ok(token,'missing PIPELINE_DISPATCH_TOKEN');assert.ok(actions,'missing Actions token');assert.notEqual(token,actions);
  const name=`pipt12-token-proof-${process.env.GITHUB_RUN_NUMBER}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'token-proof-')),file=path.join(root,'owned.json');
  const owned={repo:'romaine-life/pipeline-token-proof',branch:name},url=`${base}/repos/${owned.repo}`,original=process.env.GITHUB_REPOSITORY;
  fs.writeFileSync(file,JSON.stringify(owned));output('state',file);
  try {
    await request(api(),{token:actions});await request(api(),{token});
    await post(`${api()}/actions/workflows/token-proof.yml/dispatches`,{ref:process.env.GITHUB_HEAD_REF},{token});
    const repo=await request(url,{token});assert.equal(repo.has_actions,false);assert.equal(repo.private,true);
    const rules=await request(`${url}/branch_protections`,{token});
    assert.ok(rules.some(rule=>rule.rule_name==='main' && rule.enable_status_check && rule.apply_to_admins && rule.status_check_contexts.includes('ci-token-proof/blocked')),'fixture must block merging, including for admins');
    const before=await request(`${url}/branches/main`,{token});
    owned.id=repo.id;fs.writeFileSync(file,JSON.stringify(owned));
    await post(`${url}/branches`,{new_branch_name:name,old_branch_name:'main'},{token});
    const content=await post(`${url}/contents/probe.txt`,{branch:name,content:Buffer.from('token proof').toString('base64'),message:'Exercise publishing API permissions'},{token});
    await request(`${url}/contents/probe.txt?ref=${content.commit.sha}`,{token});
    const pr=await post(`${url}/pulls`,{head:name,base:'main',title:'PIPT-12 auto-merge proof',body:'Disposable API proof with a permanently pending required check. https://openproject.home.romaine.life/wp/PIPT-12'},{token});
    owned.pr=pr.number;fs.writeFileSync(file,JSON.stringify(owned));
    await request(`${url}/pulls?state=open&limit=50&page=1`,{token});
    const sha=pr.head.sha;
    await post(`${url}/statuses/${sha}`,{state:'pending',context:'ci-token-proof/blocked',description:'Intentionally never green: prove arming without merging'},{token});
    await denied(`${url}/pulls/${pr.number}/merge`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({Do:'squash',merge_when_checks_succeed:true,delete_branch_after_merge:true,head_commit_id:sha})});
    await armAutoMerge(pr.number,sha,{token,url});await armAutoMerge(pr.number,sha,{token,url});
    const armed=await request(`${url}/pulls/${pr.number}`,{token});assert.equal(armed.state,'open');assert.equal(armed.merged,false);
    await request(`${url}/pulls/${pr.number}/merge`,{token,method:'DELETE'});
    assert.equal((await request(`${url}/branches/main`,{token})).commit.id,before.commit.id);
    await request(`${url}/push_mirrors`,{token});
    await post(`${url}/push_mirrors-sync`,{},{token});
    console.log(JSON.stringify({actions:{ownRepo:true,crossRepoAutoMerge:404},pipelineDispatch:{branches:true,contents:true,pulls:true,statuses:true,autoMergeArmed:true,autoMergeRearmed:true,autoMergeCancelled:true,mainUnchanged:true,mirrorsRead:true,mirrorSync:true,workflowDispatch:true},scratch:owned.repo}));
  } catch(error) {console.error(error);throw error;}
  finally {process.env.GITHUB_REPOSITORY=original;process.env.PIN_TOKEN=token;await cleanup(file);fs.rmSync(root,{recursive:true,force:true});}
}
