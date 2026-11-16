import {imageInputs,imageLayout} from './image-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {capture,hash,suites} from './lib.mjs';
import {inputs,matches} from './input-patterns.mjs';
import {embedded,dockerSources,docLinks} from './dependencies.mjs';
import {packagingInputs,packagingMetadata,settings} from './release/inputs.mjs';

export const canonical=value=>JSON.stringify(value,(_,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
export function tree(ref='HEAD') {
  return capture('git',['ls-tree','-rz','--full-tree',ref]).split('\0').filter(Boolean).map(line=>{
    const split=line.indexOf('\t'),[mode,type,oid]=line.slice(0,split).split(' ');
    return {path:line.slice(split+1),mode,type,oid};
  });
}
export async function fingerprint(check,variant,cfg,suite,entries=tree()) {
  if(!inputs[check] || check==='release.build')throw new Error(`not a check: ${check}`);
  if(!/^[0-9a-f]{40,64}$/.test(suite))throw new Error('fingerprints require the exact suites commit');
  let patterns=[...inputs[check],...(cfg.inputs?.[check] || [])],configuration={},metadata=[];
  const os=variant==='windows-latest' || variant==='windows-legacy' ? 'win32' : 'linux';
  if(check==='go.test' || check==='rust.test')patterns.push(...embedded()[check.split('.')[0]]);
  if(check==='rust.test')configuration={features:cfg.rust?.platformFeatures?.[os] || cfg.rust?.features || [],noDefaultFeatures:cfg.rust?.noDefaultFeatures || false};
  if(check==='dotnet.test')configuration={sdk:cfg.dotnet?.sdk || '9.0'};
  if(check==='python.test') {
    patterns=(cfg.python?.projects || ['.']).flatMap(dir=>inputs[check].map(pattern=>dir==='.'?pattern:`${dir}/${pattern}`));
    patterns.push(...(cfg.inputs?.[check] || []));configuration={projects:cfg.python?.projects || ['.'],version:cfg.python?.version || '3.12'};
  }
  if(check==='web-app.test') {
    patterns=(cfg.web?.packages || ['.']).flatMap(dir=>inputs[check].map(pattern=>dir==='.'?pattern:`${dir}/${pattern}`));
    patterns.push(...(cfg.inputs?.[check] || []));configuration={packages:cfg.web?.packages || ['.'],node:cfg.web?.node || '24'};
  }
  if(check==='tofu.plan')configuration={version:cfg.tofu?.version || '1.11.0',backend:cfg.tofu?.backend || {}};
  if(check==='docs.validate'){patterns.push(...docLinks().flatMap(target=>[target,`${target.replace(/\/+$/,'')}/**`]),...(cfg.docs?.required || ['README.md']));configuration={required:cfg.docs?.required || ['README.md']};}
  if(check==='default.rules'){const {dependencies}=await import('./default/rules.mjs');patterns.push(...dependencies());}
  if(check==='cluster-service.manifests') {
    configuration={renders:cfg.cluster?.renders || [{kind:'kustomize',path:'k8s'}]};
    for(const render of configuration.renders){patterns.push(render.path,`${render.path}/**`);if(render.values)patterns.push(render.values);}
  }
  if(check.endsWith('.image')) {
    const kind=check==='cluster-service.image'?'cluster':'web',section=cfg[kind] || {};
    patterns=section.build===false?[]:[...imageInputs(cfg,kind,file=>{const entry=entries.find(e=>e.path===file);return entry?capture('git',['show',entry.oid]):null;}),'ci/smoke/**'];
    configuration={...imageLayout(section),build:section.build!==false,...(section.build===false?{image:section.image}:{})};
  }
  if(check==='release.package') {
    const release=packagingInputs(cfg);patterns.push(...release.patterns);configuration=settings(cfg);
    for(const selector of release.metadata)for(const entry of entries.filter(entry=>matches(entry.path,selector.path)))metadata.push({path:entry.path,kind:selector.kind,value:packagingMetadata(selector.kind,capture('git',['show',entry.oid]))});
  }
  if(variant==='services' || check==='web-app.test' || check.endsWith('.image') || check==='release.package' && cfg.release?.image)configuration={...configuration,services:cfg.service || {}};
  patterns=[...new Set(patterns)].sort();
  const files=entries.filter(entry=>patterns.some(pattern=>matches(entry.path,pattern))).sort((a,b)=>a.path.localeCompare(b.path));
  return hash(canonical({version:1,repository:process.env.GITHUB_REPOSITORY,check,variant,suite,patterns,configuration,metadata,files}));
}
export function checkVariants(suite,cfg) {
  const result=[];
  for(const check of Object.keys(inputs).filter(check=>check.startsWith(suite+'.') && check!=='release.build')) {
    const name=check.split('.')[1];
    if(['typos','machete'].includes(name) && !cfg.rust?.lints?.includes(name) || check==='cluster-service.image' && cfg.cluster?.smoke===false || check.endsWith('.image') && cfg.release?.image || check==='web-app.image' && !cfg.web?.image || check==='release.package' && !cfg.release?.toolchains?.length)continue;
    let variants=['ubuntu-latest'];
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
export function workflowJobName(workflow,id) {
  const job=workflow.jobs[id];if(!job)throw new Error(`workflow has no job ${id}`);
  const name=job.name || id;if(name.includes('${{'))throw new Error(`check producer name must be fixed: ${name}`);
  return name;
}
export function nativeJob(check,variant,workflow=suiteWorkflow(check.split('.')[0])) {
  const [suite,name]=check.split('.');
  const platform=name==='test' && ['go','rust','cmake','dotnet','python'].includes(suite) ? `check-test-${variant==='windows-latest'?'windows':'linux'}` : `check-${name}`;
  const id=check==='release.package'?'check-package':variant==='services'?'check-services':variant==='windows-legacy'?'check-parse-legacy':platform;
  return workflowJobName(workflow,id);
}
