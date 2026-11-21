// A merge publishes the image its pull request built (PIPT-56), as a release publishes the
// PR's files (PIPT-53, release/prior-build.mjs): the PR's image check builds the image with
// the tag its merge would take stamped in, its scope attests a fingerprint of everything that
// build reads, and the check keeps the image as the run's artifact; the merge, once it has
// reserved that tag, finds the run, checks the fingerprint, and pushes those exact bytes under
// the tag, the digest its PR's build made, instead of building again.
// An image joined to a release does the same: the release suite's scope attests it, its
// check-package builds and keeps it, and the release's finalize publishes it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {api,capture,hash,request,safePath,templates} from '../lib.mjs';
import {canonical,tree} from '../fingerprints.mjs';
import {matches} from '../input-patterns.mjs';
import {imageInputs} from '../dependencies.mjs';
import {attested,followed,pullRuns,templateTree,zipReadable} from '../release/prior-build.mjs';

const marker='CI_IMAGE_V1 ';
export const artifact='check-image';
// Where the check leaves the image it keeps: the image as `docker save` writes it, and what it is.
export const kept='.ci-image';

// An image that stamps its commit (ARG SOURCE_SHA) is built again on the merge: its PR can't
// know the commit the merge makes.
export const stampsCommit=text=>/^\s*ARG\s+SOURCE_SHA\b/m.test(text || '');

// The pipeline-templates files the image's build runs: image.mjs and what it reaches (lib.mjs,
// config.mjs and theirs), this file and the sign-in aside, which carry the image and don't
// make it.
export function imageSuiteInputs({entries=templateTree(),read=oid=>capture('git',['-C',templates,'cat-file','blob',oid])}={}) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry.oid]));
  return followed([],['suites/cluster-service/image.mjs'],byPath,read,['suites/cluster-service/prior-image.mjs','suites/cluster-service/registry.mjs']);
}

// What an image's build reads: its Dockerfile, .dockerignore and what the Dockerfile copies
// (imageInputs, rule 2), where it builds and what it is called, the version it stamps
// (APP_VERSION) and the suite files that build it.
export function imageFingerprint({section,version,entries=tree(),suite=imageSuiteInputs(),repository=process.env.GITHUB_REPOSITORY}) {
  if(!/^[\w.+-]+$/.test(version || ''))throw new Error('an image fingerprint needs the version it stamps');
  const read=file=>{const entry=entries.find(entry=>entry.path===file);return entry?capture('git',['show',entry.oid],{maxBuffer:1<<30}):null;};
  const patterns=[...new Set(imageInputs(section,read))].sort();
  const files=entries.filter(entry=>patterns.some(pattern=>matches(entry.path,pattern))).sort((a,b)=>a.path.localeCompare(b.path));
  return hash(canonical({version:1,repository,image:section.image,context:section.context || '.',stamp:version,suite,patterns,files}));
}
// Whether the merge can publish this image's PR build: one built here, at the version its
// merge would take, that doesn't stamp its commit.
export function reusable(section,version,read=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):null) {
  if(section.build===false || !version)return false;
  const context=section.context || '.';
  return !stampsCommit(read(context==='.'?'Dockerfile':path.posix.join(context,'Dockerfile')));
}

// The PR's scope job writes the fingerprint to its own log, which the PR's code can't reach.
export function attest(section,version,{log=console.log}={}) {
  if(!reusable(section,version)) {log(`${section.image} stamps its commit (ARG SOURCE_SHA), which its merge makes: the merge builds it`);return;}
  log(marker+JSON.stringify({head:capture('git',['rev-parse','HEAD']),fingerprint:imageFingerprint({section,version})}));
}

// The suite run whose image check a joined release's merge publishes: a module's image is
// checked by the cluster-service suite, as a cluster service's own is; any other joined image
// by the release suite's check-package, with the assembled release beside it.
export const joinedCheck=release=>release?.module ? {workflow:'cluster-service/ci.yml',job:'check-image'} : {workflow:'release/ci.yml',job:'check-package'};

// The newest run of the merged PR's suite workflow, at any of its commits, whose scope
// attested this fingerprint, whose image check (job) succeeded, and whose image is still kept
// for an hour or more.
export async function findPriorImage({sha=process.env.GITHUB_SHA,workflow,job:check='check-image',fingerprint,get=request,url=api(),now=Date.now(),probe=zipReadable,log=console.log}) {
  const found=await pullRuns(sha,workflow,get,url,log);
  if(!found)return null;
  const {pull,runs}=found;
  for(const run of runs) {
    const jobs=await get(`${url}/actions/runs/${run.id}/jobs`),scope=jobs.find(job=>job.name==='scope');
    if(!scope || jobs.find(job=>job.name===check)?.status!=='success')continue;
    const image=(await get(`${url}/actions/runs/${run.id}/artifacts`)).find(item=>item.name===artifact && !item.expired && Date.parse(item.expires_at)>now+3600e3);
    if(!image || !await attested(run,scope,fingerprint,get,url,marker))continue;
    if(!await probe(`${url}/actions/artifacts/${image.id}/zip`))throw new Error(`run ${run.id}'s image can't be downloaded with the job's token`);
    log(`Pull request #${pull.number}'s run ${run.html_url || run.id} built this image from these exact inputs as this release; publishing its image instead of building it`);
    return {run:run.id,artifact:image,pull:pull.number};
  }
  log(`No run of pull request #${pull.number} built this image from these exact inputs as this release; building it`);
  return null;
}

// The kept image goes to `directory`: image.tar and image.json, {name, id}.
export async function download(prior,{directory=kept,url=api()}={}) {
  const response=await fetch(`${url}/actions/artifacts/${prior.artifact.id}/zip`,{headers:{Authorization:`token ${process.env.TOKEN}`},signal:AbortSignal.timeout(600000)});
  if(!response.ok)throw new Error(`${artifact}: HTTP ${response.status}`);
  fs.mkdirSync(directory,{recursive:true});
  for(const [name,bytes] of Object.entries(unzipSync(new Uint8Array(await response.arrayBuffer())))) {
    if(name.endsWith('/'))continue;
    safePath(name);
    fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});
    fs.writeFileSync(path.join(directory,name),bytes);
  }
  const record=JSON.parse(fs.readFileSync(path.join(directory,'image.json'),'utf8'));
  if(!/^sha256:[0-9a-f]{64}$/.test(record.id || '') || !/^[\w./:-]+$/.test(record.name || ''))throw new Error(`run ${prior.run}'s image.json names no image`);
  return record;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {config}=await import('../config.mjs');
  const [command,kind]=process.argv.slice(2);
  const section=(kind==='web'?config().web:config().cluster) || {};
  if(command==='attest' && ['web','cluster'].includes(kind))attest(section,process.env.VERSION);
  else throw new Error('prior-image.mjs attest web|cluster');
}
