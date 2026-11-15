import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {api,request,post,capture,templates} from './lib.mjs';
import {fingerprint,checkVariants,nativeJob,suiteWorkflow,tree} from './fingerprints.mjs';
import {passCache} from './pass-cache.mjs';

export function cacheKey(check,variant,digest,prefix='ci-pass-v1') {
  if(!/^[0-9a-f]{64}$/.test(digest))throw new Error('invalid check fingerprint');
  return `${prefix}-${check.replaceAll('.','-')}-${variant}-${digest}`;
}
export function producer(check,variant) {
  const suite=check.split('.')[0];
  const workflow=suiteWorkflow(suite),job=nativeJob(check,variant,workflow);
  return {workflow:`${suite}/ci.yml`,job,context:`${workflow.name} / ${job} (pull_request)`};
}
const location=value=>new URL(value,process.env.GITHUB_SERVER_URL).pathname.replace(/\/attempt\/\d+$/,'');
export function attest(checks) {
  const entries=Object.values(checks);
  if(!entries.length)return;
  console.log('CI_FINGERPRINT_V1 '+JSON.stringify({head:entries[0].head,suite:entries[0].suite,checks:Object.fromEntries(entries.map(entry=>[entry.key,entry.fingerprint]))}));
}
async function attestation(entry,run,jobs,before,{get,url}) {
  const scope=jobs.find(job=>job.name==='scope');
  if(!scope)return null;
  for(let attempt=scope.attempt;attempt>=1;attempt--) {
    const log=await get(`${url}/actions/jobs/${scope.id}/logs?attempt=${attempt}&q=CI_FINGERPRINT_V1%20&format=ndjson`,{text:true,allow404:true});
    for(const line of (log || '').split('\n').filter(Boolean)) {
      const record=JSON.parse(line);
      if(!record.content.startsWith('CI_FINGERPRINT_V1 '))continue;
      const proof=JSON.parse(record.content.slice('CI_FINGERPRINT_V1 '.length));
      if(proof.head===run.commit_sha && proof.suite===entry.suite && proof.checks?.[entry.key]===entry.fingerprint && Date.parse(record.time)<=Date.parse(before))return Date.parse(record.time);
    }
  }
  return null;
}
export async function nativePass(entry,run,{get=request,url=api()}={}) {
  if(!run || run.workflow_id!==entry.producer.workflow || run.event!=='pull_request' || !/^[0-9a-f]{40,64}$/.test(run.commit_sha))return null;
  const jobs=await get(`${url}/actions/runs/${run.id}/jobs`),job=jobs.find(job=>job.name===entry.producer.job);
  if(!job)return null;
  const seen=new Set();
  for(let page=1;;page++) {
    const statuses=await get(`${url}/statuses/${run.commit_sha}?state=success&limit=100&page=${page}`);
    for(const status of statuses.filter(status=>status.status==='success' && status.creator===null && status.context===entry.producer.context && location(status.target_url)===location(job.html_url))) {
      if(await attestation(entry,run,jobs,status.created_at,{get,url})!==null)return {sha:run.commit_sha,url:job.html_url,run:run.id,covered:entry.check==='release.package'?jobs.filter(job=>job.name.startsWith('check-build (')).map(job=>job.name):[]};
    }
    const fresh=statuses.filter(status=>!seen.has(`${status.id}/${status.context}/${status.created_at}`));
    for(const status of fresh)seen.add(`${status.id}/${status.context}/${status.created_at}`);
    if(statuses.length<100 || !fresh.length)return null;
  }
}
export async function findPass(entry,{get=request,url=api(),cache=passCache()}={}) {
  const record=await cache.get(entry.cacheKey);
  if(!record || !Number.isSafeInteger(record.run))return null;
  const run=await get(`${url}/actions/runs/${record.run}`,{allow404:true});
  return nativePass(entry,run,{get,url});
}
export async function recordPassed(checks,{get=request,url=api(),cache=passCache(),number=process.env.GITHUB_RUN_NUMBER}={}) {
  if(!/^\d+$/.test(number || ''))throw new Error('missing native run number');
  const listing=await get(`${url}/actions/runs?run_number=${number}`);
  for(const entry of Object.values(checks).filter(entry=>!entry.pass)) {
    const run=listing.workflow_runs.find(run=>run.index_in_repo===Number(number) && run.commit_sha===entry.head && run.workflow_id===entry.producer.workflow);
    const pass=await nativePass(entry,run,{get,url});
    if(pass)await cache.set(entry.cacheKey,{run:pass.run});
  }
}
export async function plan(suite,cfg,{suiteSHA=capture('git',['-C',templates,'rev-parse','HEAD']),get=request,url=api(),cache=passCache()}={}) {
  const entries=tree(),checks={};
  for(const check of checkVariants(suite,cfg)) {
    const digest=await fingerprint(check.check,check.variant,cfg,suiteSHA,entries);
    const entry={...check,head:capture('git',['rev-parse','HEAD']),suite:suiteSHA,fingerprint:digest,cacheKey:cacheKey(check.check,check.variant,digest),producer:producer(check.check,check.variant)};
    entry.pass=await findPass(entry,{get,url,cache});checks[check.key]=entry;
  }
  return {suiteSHA,checks};
}
export async function publishReuse(checks,{send=post,get=request,url=api(),sha=process.env.GITHUB_SHA,cache=passCache()}={}) {
  if(process.env.GITHUB_EVENT_NAME!=='pull_request')throw new Error('reuse statuses are PR-only');
  for(const entry of Object.values(checks).filter(entry=>entry.pass)) {
    const pass=await findPass(entry,{url,get,cache});
    if(!pass || pass.sha!==entry.pass.sha)throw new Error('recorded check pass could not be verified');
    await send(`${url}/statuses/${sha}`,{state:'skipped',context:entry.producer.context,description:`Identical inputs; passed on ${pass.sha}`,target_url:pass.url});
    for(const job of pass.covered || [])await send(`${url}/statuses/${sha}`,{state:'skipped',context:entry.producer.context.replace(' / check-package (',' / '+job+' ('),description:`Identical packaging inputs; passed on ${pass.sha}`,target_url:pass.url});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]!=='publish')throw new Error('reuse.mjs publish');
  const checks=JSON.parse(process.env.CI_FINGERPRINTS || '{}');
  await recordPassed(checks);
  await publishReuse(checks);
}
