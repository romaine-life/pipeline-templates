import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {api,capture,post,request,output} from '../lib.mjs';
import {reserve,stagePart,finalize,materializeAsset} from '../release/protocol.mjs';
import {releasePlan} from '../release/plan.mjs';
import version from '../../actions/release-version/version.js';

export async function cleanup(file) {
  if(!file || !fs.existsSync(file))return;
  const owned=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!/^ci-draft-proof-\d+-\d+$/.test(owned.tag))throw new Error('invalid proof release cleanup');
  const rel=await request(`${api()}/releases/tags/${owned.tag}`,{allow404:true});
  if(rel){if(rel.target_commitish!==owned.sha || (owned.id && rel.id!==owned.id))throw new Error('proof release ownership changed');await request(`${api()}/releases/${rel.id}`,{method:'DELETE'});}
  await request(`${api()}/tags/${owned.tag}`,{method:'DELETE',allow404:true});
  await request(`${api()}/tags/${owned.tag}-retry.0`,{method:'DELETE',allow404:true});
  await post(`${api()}/statuses/${owned.sha}`,{state:owned.passed?'success':'skipped',context:`Release assets/${owned.tag}`,description:owned.passed?'Real draft API lifecycle passed':'Draft proof cleanup completed'});
  fs.rmSync(file,{force:true});
}
if(process.argv[2]==='cleanup')await cleanup(process.env.CI_DRAFT_PROOF_STATE);
else {
  const cwd=process.cwd(),root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'draft-proof-'));
  const sha=capture('git',['rev-parse','HEAD']),tag=`ci-draft-proof-${process.env.GITHUB_RUN_NUMBER}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`,file=path.join(root,'owned.json');
  fs.writeFileSync(file,JSON.stringify({tag,sha,passed:false}));output('state',file);
  try {
    process.chdir(root);fs.writeFileSync('.ci.json',JSON.stringify({version:1,release:{toolchains:['go'],manifest:'probe-manifest.json',checksumManifest:'SHA256SUMS'}}));
    Object.assign(process.env,{VERSION:tag,SOURCE_SHA:sha,GITHUB_SHA:sha,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main'});
    const reservation={api:api(),token:process.env.TOKEN,series:`${tag}-retry`,publish:true,sha};
    const first=await version.releaseVersion(reservation),retry=await version.releaseVersion(reservation);
    assert.equal(first.version,`${tag}-retry.0`);assert.equal(retry.version,first.version);assert.equal(retry.reserved,false);
    const legacy=await post(`${api()}/releases`,{tag_name:tag,target_commitish:sha,name:tag,body:`Joined release from ${sha}.`,draft:true,prerelease:true});
    fs.writeFileSync(file,JSON.stringify({tag,sha,id:legacy.id,passed:false}));
    const form=new FormData();form.append('attachment',new Blob([JSON.stringify({version:1,tag,sha,...releasePlan()})]),'ci-release-plan.json');
    await request(`${api()}/releases/${legacy.id}/assets?name=ci-release-plan.json`,{method:'POST',body:form});
    await reserve();await reserve();
    const recovered=await request(`${api()}/releases/tags/${tag}`);assert.equal(recovered.id,legacy.id);assert.equal(recovered.assets.length,0);
    fs.writeFileSync('probe.txt','draft attachment bytes');await stagePart('local',['probe.txt']);assert.equal(await finalize(),true);assert.equal(await finalize(),true);
    const staged=await request(`${api()}/releases/tags/${tag}`);assert.equal(staged.draft,true);assert.equal(staged.assets.length,3);
    await request(`${api()}/releases/${legacy.id}/assets/${staged.assets.find(asset=>asset.name==='probe.txt').id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'changed.txt'})});
    await assert.rejects(finalize(),/differs from its receipt/);
    await request(`${api()}/releases/${legacy.id}/assets/${staged.assets.find(asset=>asset.name==='probe.txt').id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'probe.txt'})});
    await stagePart('local',['probe.txt']);assert.equal(await finalize(),true);
    await request(`${api()}/releases?draft=false&limit=50&page=1`);
    await request(`${api()}/releases/${legacy.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})});
    await materializeAsset('probe.txt','download.txt');assert.equal(fs.readFileSync('download.txt','utf8'),'draft attachment bytes');
    fs.writeFileSync(file,JSON.stringify({tag,sha,id:legacy.id,passed:true}));console.log(JSON.stringify({tag,release:legacy.id,reusedDraft:true,reusedReservation:true,publishedDownload:true,actionsToken:true,ready:true}));
  } finally {process.chdir(cwd);await cleanup(file);fs.rmSync(root,{recursive:true,force:true});}
}
