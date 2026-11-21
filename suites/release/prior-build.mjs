// A merge publishes the build its pull request already made when nothing that goes into the
// binary changed (PIPT-53): the PR's build stamps the tag the merge would take, and its scope
// attests a fingerprint of everything the build reads, so the merge, once it has reserved
// that same tag, finds the run, checks the fingerprint, and takes its files instead of
// compiling them again. A release-external part does the same (PIPT-55): on the PR, the
// repository's build.yml stamps that tag and hands its files to complete-external.mjs, which
// packages them as a release would and attests the part's fingerprint in that job's log, and
// the workflow keeps them as the run's artifact; the merge, finding them, publishes them
// rather than dispatching build.yml.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import YAML from 'yaml';
import {api,capture,hash,output,request,safePath,templates} from '../lib.mjs';
import {canonical,tree} from '../fingerprints.mjs';
import {input} from '../input-patterns.mjs';
import {releaseInputs,settings} from './inputs.mjs';
import {releasePlan} from './plan.mjs';

const marker='CI_BUILD_V1 ';
export const artifactName=id=>`check-release-${id}`;
const readTemplate=oid=>capture('git',['-C',templates,'cat-file','blob',oid]);

// The pipeline-templates files a release build runs, so a change anywhere else there doesn't
// build again: the check-build job, every file of the actions it uses, and each script the
// build reaches from release/build.mjs and its toolchains' build.mjs, followed through every
// string in them that names a file here, documents and workflows aside. fleet.json is left
// out: the repository's own entry is its settings, which the fingerprint holds.
export function suiteInputs(kinds,{entries=templateTree(),read=readTemplate}={}) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry.oid]));
  const job=YAML.parse(read(byPath.get('suites/release/ci.yml'))).jobs['check-build'];
  return {job,files:followed(job.steps,['suites/release/build.mjs',...kinds.map(kind=>`suites/${kind==='npm' ? 'web-app' : kind}/build.mjs`)],byPath,read)};
}
// The same for an external part: the files of each action its workflow's steps use from _ci,
// and each script a step runs from _ci/suites, with what those reach. The workflow itself is
// the repository's, so the fingerprint holds it among the repository's files.
export function workflowSuiteInputs(workflow,{entries=templateTree(),read=readTemplate}={}) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry.oid]));
  const steps=Object.values(YAML.parse(workflow)?.jobs || {}).flatMap(job=>job.steps || []);
  const scripts=steps.flatMap(step=>[...String(step.run || '').matchAll(/(?<![\w/.-])(?:\.\/)?_ci\/(suites\/[\w./-]+\.mjs)/g)].map(match=>match[1]));
  return {files:followed(steps,scripts,byPath,read)};
}
function followed(steps,scripts,byPath,read) {
  const files=new Set(['suites/package-lock.json','actions/pins.txt','actions/package.json'].filter(file=>byPath.has(file)));
  const tested=file=>/(^|\/)tests?\//.test(file);
  for(const step of steps) {
    const action=step.uses?.match(/^\.\/_ci\/(actions\/[\w-]+)$/)?.[1];
    if(action)for(const file of byPath.keys())if(file.startsWith(action+'/') && !tested(file))files.add(file);
  }
  const pending=[...scripts];
  while(pending.length) {
    const file=pending.pop();
    if(!byPath.has(file) || files.has(file))continue;
    files.add(file);
    for(const [,,literal] of read(byPath.get(file)).matchAll(/(['"`])([^'"`$\n]+)\1/g)) {
      const candidates=literal.startsWith('.') ? [path.posix.join(path.posix.dirname(file),literal)] : [`suites/${literal}`,literal];
      for(const candidate of candidates.filter(candidate=>byPath.has(candidate) && candidate!=='fleet.json' && !/\.(md|ya?ml)$/.test(candidate) && !tested(candidate))) {
        if(/\.m?js$/.test(candidate))pending.push(candidate);else files.add(candidate);
      }
    }
  }
  return [...files].sort().map(file=>({path:file,oid:byPath.get(file)}));
}
function templateTree() {
  return capture('git',['-C',templates,'ls-tree','-r','--full-tree','HEAD']).split('\n').filter(Boolean).map(line=>{
    const [meta,file]=line.split('\t');return {path:file,oid:meta.split(' ')[2]};
  });
}

// What a release build reads: the files a merge's release reads (release.build, tests and
// documentation aside), the version it stamps, the suite files that build it, the repository's
// settings and the parts it builds. BUILD_TIME is left out: the release says when it was built.
export function buildFingerprint({cfg,version,entries=tree(),plan=releasePlan(cfg),suite=suiteInputs([...new Set(plan.matrix.include.map(part=>part.toolchain))]),repository=process.env.GITHUB_REPOSITORY}) {
  if(!/^[\w.+-]+$/.test(version || ''))throw new Error('a build fingerprint needs the version it stamps');
  const read=file=>{const entry=entries.find(entry=>entry.path===file);return entry?capture('git',['show',entry.oid]):null;};
  const patterns=[...new Set(releaseInputs(cfg,read))].sort();
  const files=entries.filter(entry=>input(entry.path,'release.build',patterns)).sort((a,b)=>a.path.localeCompare(b.path));
  return hash(canonical({version:2,repository,suite,stamp:version,topics:cfg.topics || [],settings:settings(cfg),parts:plan.matrix.include,patterns,files}));
}
// An external part's: the same files, stamp and settings, with the part itself as the build's
// one part and the suite files its workflow runs in place of check-build's.
export function externalFingerprint({cfg,part,version,entries=tree(),repository=process.env.GITHUB_REPOSITORY,suite}) {
  if(!suite) {
    const workflow=entries.find(entry=>entry.path===`.forgejo/workflows/${part.workflow}`);
    if(!workflow)throw new Error(`release part ${part.id} has no .forgejo/workflows/${part.workflow}`);
    suite=workflowSuiteInputs(capture('git',['show',workflow.oid]));
  }
  return buildFingerprint({cfg,version,entries,repository,suite,plan:{matrix:{include:[{id:part.id,toolchain:'external',workflow:part.workflow}]}}});
}

// The PR's scope job writes the fingerprint to its own log, which the PR's code can't reach.
// An external part's build writes its own (complete-external.mjs): its workflow is the
// repository's either way, the same file the merge would dispatch.
export function attest(fingerprint,head=capture('git',['rev-parse','HEAD'])) {
  console.log(marker+JSON.stringify({head,fingerprint}));
}
async function attested(run,job,fingerprint,get,url) {
  for(let attempt=job.attempt || 1;attempt>=1;attempt--) {
    const log=await get(`${url}/actions/jobs/${job.id}/logs?attempt=${attempt}&q=${encodeURIComponent(marker)}&format=ndjson`,{text:true,allow404:true});
    for(const line of (log || '').split('\n').filter(Boolean)) {
      const content=JSON.parse(line).content || '';
      if(!content.startsWith(marker))continue;
      const proof=JSON.parse(content.slice(marker.length));
      if(proof.head===run.commit_sha && proof.fingerprint===fingerprint)return true;
    }
  }
  return false;
}

// The merged PR's runs of a workflow, at any of its commits, newest first.
async function pullRuns(sha,workflow,get,url,log) {
  const pull=await get(`${url}/commits/${sha}/pull`,{allow404:true});
  if(!pull?.number || !pull.merged){log(`${sha} merged no pull request; building`);return null;}
  const heads=[];
  for(let page=1;;page++) {
    const batch=await get(`${url}/pulls/${pull.number}/commits?limit=50&page=${page}&stat=false&verification=false&files=false`);
    heads.push(...batch.map(commit=>commit.sha));
    if(batch.length<50)break;
  }
  const runs=[];
  for(const head of heads) {
    // Not ?event=pull_request: Forgejo's filter leaves out the runs a push to the PR starts.
    const listing=await get(`${url}/actions/runs?head_sha=${head}&limit=50`);
    runs.push(...(listing.workflow_runs || []).filter(run=>run.event==='pull_request' && run.workflow_id===workflow && run.commit_sha===head));
  }
  return {pull,runs:runs.sort((a,b)=>b.id-a.id)};
}
const keptFor=(artifacts,id,now)=>artifacts.find(artifact=>artifact.name===artifactName(id) && !artifact.expired && Date.parse(artifact.expires_at)>now+3600e3);

// The newest run of the merged PR's release suite, at any of its commits, whose scope attested this fingerprint, whose
// every build part succeeded, and whose files are all still kept for an hour or more.
export async function findPrior({sha=process.env.GITHUB_SHA,fingerprint,parts,get=request,url=api(),now=Date.now(),probe=zipReadable,log=console.log}) {
  const found=await pullRuns(sha,'release/ci.yml',get,url,log);
  if(!found)return null;
  const {pull,runs}=found;
  for(const run of runs) {
    const jobs=await get(`${url}/actions/runs/${run.id}/jobs`),scope=jobs.find(job=>job.name==='scope');
    const builds=jobs.filter(job=>job.name.startsWith('check-build ('));
    if(!scope || builds.length!==parts.length || builds.some(job=>job.status!=='success'))continue;
    const artifacts=await get(`${url}/actions/runs/${run.id}/artifacts`);
    const kept=parts.map(id=>keptFor(artifacts,id,now));
    if(kept.some(artifact=>!artifact))continue;
    if(!await attested(run,scope,fingerprint,get,url))continue;
    // The finalize job downloads with the same kind of token: proven here, while building is still the fallback.
    if(!await probe(`${url}/actions/artifacts/${kept[0].id}/zip`))throw new Error(`run ${run.id}'s files can't be downloaded with the job's token`);
    log(`Pull request #${pull.number}'s run ${run.html_url || run.id} built these exact inputs as this release; publishing its files`);
    return {run:run.id,artifacts:kept};
  }
  log(`No run of pull request #${pull.number} built these exact inputs as this release; building`);
  return null;
}
// The newest run of the merged PR's external workflow (the part's build.yml) in which a job
// that succeeded attested this part's fingerprint, and whose packaged files are still kept
// for an hour or more.
export async function findPriorExternal({sha=process.env.GITHUB_SHA,fingerprint,part,get=request,url=api(),now=Date.now(),probe=zipReadable,log=console.log}) {
  const found=await pullRuns(sha,part.workflow,get,url,log);
  if(!found)return null;
  const {pull,runs}=found;
  for(const run of runs) {
    const artifact=keptFor(await get(`${url}/actions/runs/${run.id}/artifacts`),part.id,now);
    if(!artifact)continue;
    let proven=false;
    for(const job of (await get(`${url}/actions/runs/${run.id}/jobs`)).filter(job=>job.status==='success'))if(await attested(run,job,fingerprint,get,url)){proven=true;break;}
    if(!proven)continue;
    if(!await probe(`${url}/actions/artifacts/${artifact.id}/zip`))throw new Error(`run ${run.id}'s files can't be downloaded with the job's token`);
    log(`Pull request #${pull.number}'s ${part.workflow} run ${run.html_url || run.id} built release part ${part.id} from these exact inputs as this release; publishing its files instead of dispatching ${part.workflow}`);
    return {run:run.id,artifact};
  }
  log(`No ${part.workflow} run of pull request #${pull.number} built release part ${part.id} from these exact inputs as this release; dispatching it`);
  return null;
}
async function zipReadable(address) {
  const response=await fetch(address,{headers:{Authorization:`token ${process.env.TOKEN}`,Range:'bytes=0-0'},signal:AbortSignal.timeout(30000)});
  await response.body?.cancel();
  return response.ok;
}

// Each part's files go to parts/release-<id>/, where assemble.mjs reads a build's artifacts.
export async function download(run,parts,{get=request,url=api(),directory='parts'}={}) {
  const artifacts=await get(`${url}/actions/runs/${run}/artifacts`);
  for(const id of parts) {
    const artifact=artifacts.find(artifact=>artifact.name===artifactName(id) && !artifact.expired);
    if(!artifact)throw new Error(`run ${run} no longer holds ${artifactName(id)}`);
    const response=await fetch(`${url}/actions/artifacts/${artifact.id}/zip`,{headers:{Authorization:`token ${process.env.TOKEN}`},signal:AbortSignal.timeout(300000)});
    if(!response.ok)throw new Error(`${artifactName(id)}: HTTP ${response.status}`);
    const target=path.join(directory,`release-${id}`);
    fs.mkdirSync(target,{recursive:true});
    for(const [name,bytes] of Object.entries(unzipSync(new Uint8Array(await response.arrayBuffer())))) {
      if(name.endsWith('/'))continue;
      safePath(name);
      fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});
      fs.writeFileSync(path.join(target,name),bytes);
    }
  }
}

// The merge's reserve job: the PR runs whose files this release publishes, the local parts'
// (prior-run) and each external part's (prior-external, {part: run}); a part with none builds.
// A lookup that fails builds, as every release did before.
export async function findAll({cfg,plan,version,find=findPrior,findExternal=findPriorExternal,log=console.log}) {
  let local=null;const external={};
  if(plan.local) {
    try {local=await find({fingerprint:buildFingerprint({cfg,version,plan}),parts:plan.matrix.include.map(part=>part.id)});}
    catch(error){log(`::warning::Looking for the pull request's build failed, so the release builds: ${error.message}`);}
  }
  for(const part of plan.external) {
    try {const prior=await findExternal({fingerprint:externalFingerprint({cfg,part,version}),part});if(prior)external[part.id]=prior.run;}
    catch(error){log(`::warning::Looking for the pull request's build of ${part.id} failed, so the release dispatches ${part.workflow}: ${error.message}`);}
  }
  return {local:local?.run ?? '',external:Object.keys(external).length ? JSON.stringify(external) : ''};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {config}=await import('../config.mjs');
  const command=process.argv[2],cfg=config(),plan=releasePlan(cfg),parts=plan.matrix.include.map(part=>part.id);
  if(command==='attest') {
    attest(buildFingerprint({cfg,version:process.env.VERSION,plan}));
  } else if(command==='find') {
    const prior=await findAll({cfg,plan,version:process.env.VERSION});
    output('prior-run',prior.local);
    output('prior-external',prior.external);
  } else if(command==='download') {
    if(!/^\d+$/.test(process.env.PRIOR_RUN || ''))throw new Error('download needs PRIOR_RUN');
    await download(process.env.PRIOR_RUN,parts);
  } else if(command==='external') {
    // Each reused external part's files go to its PR run's packaged names, then to the draft.
    const {stagePart}=await import('./protocol.mjs');
    const reused=JSON.parse(process.env.PRIOR_EXTERNAL || '{}');
    for(const [id,run] of Object.entries(reused)) {
      if(!plan.external.some(part=>part.id===id) || !Number.isSafeInteger(run))throw new Error(`PRIOR_EXTERNAL names no release part's run: ${id}`);
      await download(run,[id],{directory:'external'});
      const folder=path.join('external',`release-${id}`);
      await stagePart(id,fs.readdirSync(folder).map(file=>path.join(folder,file)),{reused:true});
      console.log(`Release part ${id}: published pull request run ${run}'s files, built by nothing on this merge`);
    }
  } else throw new Error('prior-build.mjs attest|find|download|external');
}
