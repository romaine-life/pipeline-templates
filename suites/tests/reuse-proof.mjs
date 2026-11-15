import fs from 'node:fs';
import path from 'node:path';
import {capture,output,templates,api,request} from '../lib.mjs';

const platforms=['ubuntu-latest','windows-latest'];
const fixtureConfig=()=>{
  const value=JSON.parse(fs.readFileSync('suites/platform-proof.json','utf8'));
  return {value,cfg:{version:1,rust:{platforms,platformFeatures:value.platformFeatures}}};
};
if(process.argv[2]==='ref') {
  const selection=fs.readFileSync('suites/tests/reuse-suite-ref.txt','utf8').trim();
  const ref=selection==='code' ? capture('git',['log','-1','--format=%H','--','suites/fingerprints.mjs','suites/inputs.mjs','suites/config.mjs','suites/rust/test.mjs','suites/rust/cache.mjs','suites/reuse.mjs','suites/pass-cache.mjs','suites/lib.mjs','suites/input-patterns.mjs','suites/dependencies.mjs','suites/release/inputs.mjs','suites/release/plan.mjs','suites/default/rules.mjs','suites/package.json','suites/package-lock.json','actions/suite/action.yml','suites/tests/reuse-proof.mjs','.forgejo/workflows/fingerprint-proof.yml']) : capture('git',['rev-parse','--verify',`${selection}^{commit}`]);
  if(!/^[0-9a-f]{40,64}$/.test(ref))throw new Error('missing proof suite ref');output('ref',ref);
} else if(process.argv[2]==='scope') {
  const {default:YAML}=await import('yaml');
  const {fingerprint,workflowJobName}=await import('../fingerprints.mjs');
  const {testPlatforms}=await import('../inputs.mjs');
  const {releasePlan}=await import('../release/plan.mjs');
  const {cacheKey,findPass,attest}=await import('../reuse.mjs');
  const suite=capture('git',['-C',templates,'rev-parse','HEAD']),{value,cfg}=fixtureConfig(),checks={};
  const workflow=YAML.parse(fs.readFileSync(path.join(templates,'.forgejo/workflows/fingerprint-proof.yml'),'utf8'));
  for(const runner of platforms) {
    const key=`rust.test/${runner}`,digest=await fingerprint('rust.test',runner,cfg,suite),job=workflowJobName(workflow,runner==='windows-latest'?'check-test-windows':'check-test-linux');
    const entry={key,check:'rust.test',variant:runner,head:capture('git',['rev-parse','HEAD']),suite,fingerprint:digest,cacheKey:cacheKey('rust.test',runner,digest,'ci-proof-platform-v3'),producer:{workflow:'fingerprint-proof.yml',job,context:`${workflow.name} / ${job} (pull_request)`}};
    entry.pass=await findPass(entry);checks[key]=entry;
  }
  const passed=Object.values(checks).filter(entry=>entry.pass).length,scenario=passed===0?'none':passed===platforms.length?'all':'one';
  const plan=testPlatforms('rust',cfg,runner=>!checks[`rust.test/${runner}`].pass);
  const release=releasePlan({version:1,release:{external:[{id:'macos',repository:'romaine-life/fixture',workflow:'macos.yml',assets:['macos.zip']}]}});
  attest(checks);output('checks',JSON.stringify(checks));output('suite',suite);output('test-linux',plan.run['ubuntu-latest']===true);output('test-windows',plan.run['windows-latest']===true);output('release-matrix',JSON.stringify(release.matrix));output('has-local',release.local);
  console.log(JSON.stringify({scenario,platforms:plan.platforms,run:plan.run}));
} else if(process.argv[2]==='check') {
  const {run}=await import('../lib.mjs'),{cfg}=fixtureConfig();
  const root=path.resolve('suites/tests/matrix-project');
  fs.writeFileSync(path.join(root,'.ci.json'),JSON.stringify(cfg));
  try {run(process.execPath,[path.join(templates,'suites/rust/test.mjs')],{cwd:root});}
  finally {fs.rmSync(path.join(root,'.ci.json'),{force:true});}
} else if(process.argv[2]==='verify') {
  const {findPass,publishReuse,recordPassed}=await import('../reuse.mjs');
  const checks=JSON.parse(process.env.CI_FINGERPRINTS);
  await recordPassed(checks);await publishReuse(checks);
  const listing=await request(`${api()}/actions/runs?run_number=${process.env.GITHUB_RUN_NUMBER}`),run=listing.workflow_runs.find(run=>run.index_in_repo===Number(process.env.GITHUB_RUN_NUMBER) && run.workflow_id==='fingerprint-proof.yml');
  const jobs=await request(`${api()}/actions/runs/${run.id}/jobs`),combined=await request(`${api()}/commits/${process.env.GITHUB_SHA}/status`),result=[];
  for(const entry of Object.values(checks)) {
    const pass=await findPass(entry);if(!pass)throw new Error('real check did not produce a verifiable pass record');
    const job=jobs.find(job=>job.name===entry.producer.job);if(job?.status!==(entry.pass?'skipped':'success'))throw new Error(`wrong native platform result: ${entry.variant}: ${job?.status}`);
    if(entry.pass) {
      const status=combined.statuses.find(status=>status.context===entry.producer.context);
      if(status?.status!=='skipped' || !status.description.includes(pass.sha))throw new Error('reused status must be skipped and name the passing commit');
    }
    result.push({platform:entry.variant,native:job.status,passedOn:pass.sha,reused:!!entry.pass,fingerprint:entry.fingerprint});
  }
  const external=jobs.filter(job=>job.name.startsWith('release-build'));
  if(!external.length || external.some(job=>job.status!=='skipped'))throw new Error('external-only release must have a skipped build row');
  console.log(JSON.stringify({head:process.env.GITHUB_SHA,scenario:result.every(entry=>entry.reused)?'all':result.some(entry=>entry.reused)?'one':'none',checks:result,externalOnly:external.map(job=>({name:job.name,status:job.status}))}));
} else throw new Error('reuse-proof.mjs ref|scope|check|verify');
