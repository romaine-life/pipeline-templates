import fs from 'node:fs';
import {capture, output} from './lib.mjs';
import {config} from './config.mjs';
import {embedded, dockerSources, docLinks} from './dependencies.mjs';

import {inputs,relevant} from './input-patterns.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export {inputs,matches,relevant} from './input-patterns.mjs';
export function changed(base = process.env.BASE, head = 'HEAD') {
  if (!/^[0-9a-f]{40,64}$/i.test(base || '')) throw new Error('BASE must name the exact PR base commit; no run-everything fallback');
  return capture('git', ['diff', '--name-only', '-z', '--no-renames', `${base}...${head}`]).split('\0').filter(Boolean);
}
export function pushFiles(before = process.env.BEFORE, head = process.env.GITHUB_SHA || 'HEAD') {
  if (!before || /^0+$/.test(before)) return null;
  if (!/^[0-9a-f]{40,64}$/i.test(before)) throw new Error('invalid push before SHA');
  return capture('git', ['diff', '--name-only', '-z', '--no-renames', before, head]).split('\0').filter(Boolean);
}
export function testPlatforms(suite,cfg,needed) {
  const platforms=cfg[suite]?.platforms || ['ubuntu-latest'];
  const services=['go','rust'].includes(suite) && Object.keys(cfg.service || {}).length>0;
  return {platforms,run:Object.fromEntries(platforms.map(platform=>[platform,!(services && platform==='ubuntu-latest') && needed(platform)]))};
}
export async function scope(suite) {
  const cfg = config();
  for (const job of Object.keys(cfg.inputs || {})) if (!inputs[job]) throw new Error(`unknown check input: ${job}`);
  cfg.inputs = {...cfg.inputs};
  const add = (job, paths) => cfg.inputs[job] = [...(cfg.inputs[job] || []), ...paths];
  if (suite === 'python') for (const dir of cfg.python?.projects || ['.']) add('python.test', inputs['python.test'].map(p=>dir==='.' ? p : `${dir}/${p}`));
  if (suite === 'release') add('release.build',[...(cfg.release?.dependencies || []).flatMap(d=>d.lock ? [d.lock] : []),...(cfg.release?.archives || []).flatMap(a=>a.sources)]);
  if (['go', 'rust'].includes(suite)) add(`${suite}.test`, embedded()[suite]);
  if (suite === 'docs') add('docs.validate', docLinks());
  if (['cluster-service', 'web-app'].includes(suite) && fs.existsSync('Dockerfile')) add(`${suite}.image`, dockerSources(fs.readFileSync('Dockerfile', 'utf8')));
  if (suite === 'default') {
    const {dependencies} = await import('./default/rules.mjs');
    cfg.inputs = {...cfg.inputs, 'default.rules': [...(cfg.inputs?.['default.rules'] || []), ...dependencies()]};
  }
  const files = process.env.GITHUB_EVENT_NAME === 'pull_request' || !process.env.GITHUB_EVENT_NAME ? changed() : [];
  let reuse;
  if(process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_EVENT_NAME==='pull_request') {
    if(!process.env.TOKEN)throw new Error('check reuse scope requires the Actions token');
    const {plan,attest}=await import('./reuse.mjs');reuse=await plan(suite,config());attest(reuse.checks);
  }
  // A check runs when its inputs changed against the base (rule 2), and on a PR only when no
  // run of the same inputs has passed yet. A recorded pass lets a PR skip what it already ran;
  // it never makes a check run whose inputs the PR didn't touch.
  const needed=(check,variant)=>!reuse || Object.values(reuse.checks).some(entry=>entry.check===check && (!variant || entry.variant===variant) && !entry.pass);
  const testInputs=`${suite}.test` in inputs?`${suite}.test`:'go.test';
  for (const job of Object.keys(inputs).filter(k => k.startsWith(`${suite}.`))) {
    if(job==='release.package') {
      const {packagingScope}=await import('./release/inputs.mjs');
      output('package',files.length>0 && packagingScope(files,cfg) && needed(job));
      continue;
    }
    const disabled=job==='cluster-service.image' && cfg.cluster?.smoke===false || ['rust.typos','rust.machete'].includes(job) && !cfg.rust?.lints?.includes(job.split('.')[1]);
    output(job.split('.')[1], !disabled && relevant(files, job, cfg) && (job==='release.build' || needed(job,job==='powershell.parse'?'ubuntu-latest':undefined)));
  }
  if (suite === 'tofu') {
    const pushed = process.env.GITHUB_EVENT_NAME === 'push' ? pushFiles() : null;
    output('apply', process.env.GITHUB_EVENT_NAME !== 'pull_request' && (pushed === null || relevant(pushed, 'tofu.plan', cfg)));
  }
  output('has-services', Object.keys(cfg.service || {}).length > 0);
  const platforms=testPlatforms(suite,cfg,platform=>relevant(files,testInputs,cfg) && needed(`${suite}.test`,platform));
  output('platforms',JSON.stringify(platforms.platforms));
  output('test-linux',platforms.run['ubuntu-latest']===true);
  output('test-windows',platforms.run['windows-latest']===true);
  output('service-test',Object.keys(cfg.service || {}).length>0 && relevant(files,testInputs,cfg) && needed(`${suite}.test`,'services'));
  output('parse-legacy',suite==='powershell' && cfg.powershell?.windowsPowerShell===true && relevant(files,'powershell.parse',cfg) && needed('powershell.parse','windows-legacy'));
  output('fingerprints',JSON.stringify(reuse?.checks || {}));
  output('suite-sha',reuse?.suiteSHA || capture('git',['-C',path.dirname(fileURLToPath(import.meta.url)),'rev-parse','HEAD']));
  output('reuse',Object.values(reuse?.checks || {}).some(entry=>entry.pass));
  output('windows-powershell', cfg.powershell?.windowsPowerShell === true);
  output('source-release', cfg.docs?.release === true);
  output('joined-image', cfg.release?.image || '');
  output('module', cfg.release?.module === true);
  // The cluster suite checks the image on a PR unless a joined release's package check does;
  // a module's release has no package to check, so its joined image is checked here.
  output('cluster-image-check', !cfg.release?.image || cfg.release?.module === true);
  output('prefix', cfg.release?.prefix || (cfg.release?.prefixFrom ? '' : 'v0.1'));
  output('prefix-from', cfg.release?.prefixFrom || '');
  output('suffix', cfg.release?.suffix || '');
  output('node', cfg.web?.node || '24');
  output('tofu', cfg.tofu?.version || '1.11.0');
  output('dotnet', cfg.dotnet?.sdk || '9.0');
  output('python', cfg.python?.version || '3.12');
  output('static-app', Boolean(cfg.web?.staticApp));
  output('has-image', Boolean(cfg.web?.image));
  output('has-dispatch', Boolean(cfg.release?.dispatch?.length || cfg.release?.mirror));
  for (const name of ['postgres', 'manticore', 'greenmail']) output(name, cfg.service?.[name] || '');
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await scope(process.argv[2]);
