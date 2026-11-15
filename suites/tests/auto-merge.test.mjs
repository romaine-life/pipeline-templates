import test from 'node:test';
import assert from 'node:assert/strict';
import {armAutoMerge} from '../auto-merge.mjs';

test('auto-merge binds squash and branch deletion to the pushed head, and re-arms an identical scheduled PR',async()=>{
  const sha='a'.repeat(40),calls=[],options={token:'pr-token',url:'https://forgejo.example/api/v1/repos/o/r',send:async(url,body,auth)=>{calls.push({url,body,auth});}};
  await armAutoMerge(7,sha,options);
  assert.deepEqual(calls[0].body,{Do:'squash',merge_when_checks_succeed:true,delete_branch_after_merge:true,head_commit_id:sha});assert.equal(calls[0].auth.token,'pr-token');
  await assert.rejects(armAutoMerge(7,sha,{...options,token:undefined}),/PIPELINE_DISPATCH_TOKEN/);
  let sent=0,removed=0;
  const retry={...options,send:async()=>{if(++sent===1)throw new Error('POST: HTTP 409');},get:async(url,auth)=>{assert.equal(auth.token,'pr-token');if(auth.method==='DELETE'){removed++;return null;}return {state:'open',head:{sha}};}};
  await armAutoMerge(7,sha,retry);assert.equal(sent,2);assert.equal(removed,1);
  sent=0;await assert.rejects(armAutoMerge(7,sha,{...retry,get:async()=>({state:'open',head:{sha:'b'.repeat(40)}})}),/409/);
});
