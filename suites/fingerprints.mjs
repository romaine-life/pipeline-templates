import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {capture,hash,suites} from './lib.mjs';
import {inputs,input,ignoredBy,matches,packageInputs} from './input-patterns.mjs';
import {embedded,imageInputs,docLinks,packageReferences} from './dependencies.mjs';
import {packagingInputs,packagingMetadata,releaseInputs,settings} from './release/inputs.mjs';
import {pythonProjects,requiredDocs,tofuVersion} from './conventions.mjs';

export const canonical=value=>JSON.stringify(value,(_,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
export function tree(ref='HEAD') {
  return capture('git',['ls-tree','-rz','--full-tree',ref]).split('\0').filter(Boolean).map(line=>{
    const split=line.indexOf('\t'),[mode,type,oid]=line.slice(0,split).split(' ');
    return {path:line.slice(split+1),mode,type,oid};
  });
}
// The inputs a check reads that the repository names rather than its patterns (rule 2): the
// same list decides whether the check runs (relevant) and what its fingerprint covers.
export async function found(check,cfg,read) {
  if(check==='go.test' || check==='rust.test')return embedded()[check.split('.')[0]];
  if(check==='docs.validate')return [...docLinks().flatMap(target=>[target,`${target.replace(/\/+$/,'')}/**`]),...requiredDocs];
  if(check==='default.rules'){const {dependencies}=await import('./default/rules.mjs');return dependencies();}
  if(check.endsWith('.image'))return imageInputs((check==='cluster-service.image'?cfg.cluster:cfg.web) || {},read);
  if(check==='release.build')return releaseInputs(cfg,read);
  if(check==='release.package')return packagingInputs(cfg,read).patterns;
  return [];
}
// An npm package's tests (web-app.test, its folder the variant): the patterns they read, its own
// folder and those it references, whose documentation doesn't count (packageInputs), and the
// files it names elsewhere, which count wherever they are.
export function packageCheck(dir,files,read) {
  const references=packageReferences(dir,files,read);
  return {own:packageInputs(dir,references),found:references.flatMap(name=>[name,...(path.posix.extname(name)?[]:[`${name}.*`])])};
}
export async function fingerprint(check,variant,cfg,suite,entries=tree()) {
  if(!inputs[check] || check==='release.build')throw new Error(`not a check: ${check}`);
  if(!/^[0-9a-f]{40,64}$/.test(suite))throw new Error('fingerprints require the exact suites commit');
  let configuration={},metadata=[];
  if(check==='dotnet.test')configuration={sdk:'9.0'};
  // .python-version and .nvmrc are inputs to these checks, so their versions are in the fingerprint.
  if(check==='python.test')configuration={projects:pythonProjects(entries.map(entry=>entry.path))};
  if(check==='web-app.test')configuration={package:variant};
  if(check==='tofu.plan')configuration={version:tofuVersion};
  if(check==='cluster-service.manifests')configuration={renders:cfg.cluster?.renders || []};
  if(check.endsWith('.image')) {
    const section=(check==='cluster-service.image'?cfg.cluster:cfg.web) || {};
    configuration={build:section.build!==false,...(section.context?{context:section.context}:{}),...(section.build===false?{image:section.image}:{})};
  }
  if(check==='release.package') {
    configuration=settings(cfg);
    for(const selector of packagingInputs(cfg).metadata)for(const entry of entries.filter(entry=>matches(entry.path,selector.path)))metadata.push({path:entry.path,kind:selector.kind,value:packagingMetadata(selector.kind,capture('git',['show',entry.oid]))});
  }
  if(variant==='services' || check==='web-app.test' || check.endsWith('.image') || check==='release.package' && cfg.release?.image)configuration={...configuration,services:cfg.service || {}};
  const read=file=>{const entry=entries.find(entry=>entry.path===file);return entry?capture('git',['show',entry.oid],{maxBuffer:1<<30}):null;};
  const npm=check==='web-app.test'?packageCheck(variant,entries.map(entry=>entry.path),read):null;
  const own=npm?.own || inputs[check];
  const patterns=[...new Set(npm?.found || await found(check,cfg,read))].sort();
  const files=entries.filter(entry=>input(entry.path,check,patterns,own)).sort((a,b)=>a.path.localeCompare(b.path));
  // The repository's setting topics are its configuration too: a topic change never reuses a pass.
  return hash(canonical({version:1,repository:process.env.GITHUB_REPOSITORY,check,variant,suite,ignored:ignoredBy(check),patterns:[...own,...patterns],configuration,topics:cfg.topics || [],metadata,files}));
}
export function checkVariants(suite,cfg) {
  const result=[];
  for(const check of Object.keys(inputs).filter(check=>check.startsWith(suite+'.') && check!=='release.build')) {
    const name=check.split('.')[1];
    if(['typos','machete','audit'].includes(name) && !cfg.rust?.lints?.includes(name) || check==='cluster-service.image' && cfg.cluster?.smoke===false || check.endsWith('.image') && cfg.release?.image && !(check==='cluster-service.image' && cfg.release?.module) || check==='web-app.image' && !cfg.web?.image || check==='release.package' && !cfg.release?.toolchains?.length)continue;
    let variants=check==='web-app.test'?[...(cfg.web?.packages || ['.'])]:['ubuntu-latest'];
    if(name==='test' && ['go','rust','cmake','dotnet','python'].includes(suite)) {
      variants=[...(cfg[suite]?.platforms || ['ubuntu-latest'])];
      if(['go','rust'].includes(suite) && Object.keys(cfg.service || {}).length){variants=variants.filter(variant=>variant!=='ubuntu-latest');variants.push('services');}
    }
    if(check==='powershell.parse' && cfg.powershell?.windowsPowerShell)variants.push('windows-legacy');
    for(const variant of variants)result.push({check,variant,key:`${check}/${variant}`});
  }
  return result;
}
export const suiteWorkflow=suite=>YAML.parse(fs.readFileSync(path.join(suites,suite,'ci.yml'),'utf8'));
// A job's name; a matrix job's as Forgejo names each of its jobs, the job's name and then its
// matrix values (an npm package's check-test is `check-test (frontend)`).
export function workflowJobName(workflow,id,matrix) {
  const job=workflow.jobs[id];if(!job)throw new Error(`workflow has no job ${id}`);
  const name=job.name || id;if(name.includes('${{'))throw new Error(`check producer name must be fixed: ${name}`);
  if(Boolean(job.strategy?.matrix)!==Boolean(matrix))throw new Error(`${id}: a matrix job's name needs its matrix values, and only its`);
  return matrix ? `${name} (${Object.values(matrix).join(', ')})` : name;
}
export function nativeJob(check,variant,workflow=suiteWorkflow(check.split('.')[0])) {
  const [suite,name]=check.split('.');
  const platform=name==='test' && ['go','rust','cmake','dotnet','python'].includes(suite) ? `check-test-${variant==='windows-latest'?'windows':'linux'}` : `check-${name}`;
  const id=check==='release.package'?'check-package':variant==='services'?'check-services':variant==='windows-legacy'?'check-parse-legacy':platform;
  return workflowJobName(workflow,id,check==='web-app.test'?{package:variant}:undefined);
}
