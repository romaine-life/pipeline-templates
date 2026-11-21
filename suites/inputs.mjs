import fs from 'node:fs';
import {capture, output} from './lib.mjs';
import {config} from './config.mjs';
import {nodeVersion,pythonVersion,releaseManifest,tofuVersion} from './conventions.mjs';
import {inputs,relevant} from './input-patterns.mjs';
import {found,packageCheck} from './fingerprints.mjs';
import {ownPackage} from './packages.mjs';
import {ownModule} from './go/modules.mjs';
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
  const testInputs=`${suite}.test` in inputs?`${suite}.test`:'go.test',testFound=testInputs===`${suite}.test` ? await found(testInputs,cfg) : [];
  for (const job of Object.keys(inputs).filter(k => k.startsWith(`${suite}.`))) {
    if(job==='release.package') {
      const {packagingScope}=await import('./release/inputs.mjs');
      output('package',files.length>0 && packagingScope(files,cfg) && needed(job));
      continue;
    }
    // Each npm package's tests run when its own inputs changed (packageCheck), as a job of
    // check-test's matrix. With none to run the job is skipped; its matrix still names them all.
    if(job==='web-app.test') {
      const packages=cfg.web?.packages || ['.'],run=[];
      for(const dir of packages){const npm=packageCheck(dir);if(relevant(files,job,npm.found,npm.own) && needed(job,dir))run.push(dir);}
      output('test',run.length>0);
      output('test-packages',JSON.stringify({package:run.length?run:packages}));
      continue;
    }
    const disabled=job==='cluster-service.image' && cfg.cluster?.smoke===false || ['rust.typos','rust.machete','rust.audit'].includes(job) && !cfg.rust?.lints?.includes(job.split('.')[1]);
    output(job.split('.')[1], !disabled && relevant(files, job, await found(job, cfg)) && (job==='release.build' || needed(job,job==='powershell.parse'?'ubuntu-latest':undefined)));
  }
  if (suite === 'tofu') {
    const pushed = process.env.GITHUB_EVENT_NAME === 'push' ? pushFiles() : null;
    output('apply', process.env.GITHUB_EVENT_NAME !== 'pull_request' && (pushed === null || relevant(pushed, 'tofu.plan')));
  }
  output('has-services', Object.keys(cfg.service || {}).length > 0);
  const platforms=testPlatforms(suite,cfg,platform=>relevant(files,testInputs,testFound) && needed(`${suite}.test`,platform));
  output('platforms',JSON.stringify(platforms.platforms));
  output('test-linux',platforms.run['ubuntu-latest']===true);
  output('test-windows',platforms.run['windows-latest']===true);
  output('service-test',Object.keys(cfg.service || {}).length>0 && relevant(files,testInputs,testFound) && needed(`${suite}.test`,'services'));
  output('parse-legacy',suite==='powershell' && cfg.powershell?.windowsPowerShell===true && relevant(files,'powershell.parse') && needed('powershell.parse','windows-legacy'));
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
  // A release numbers on from its newest tag (actions/release-version), or on its manifest's version.
  output('prefix', '');
  output('prefix-from', cfg.release?.fromManifest ? releaseManifest() : '');
  output('suffix', cfg.release?.suffix || '');
  output('node', nodeVersion());
  output('tofu', tofuVersion);
  output('dotnet', '9.0');
  output('python', pythonVersion());
  output('static-app', Boolean(cfg.web?.staticApp));
  output('has-image', Boolean(cfg.web?.image));
  output('test-history', cfg.web?.history === true);
  output('has-dispatch', Boolean(suite==='release' || cfg.release?.dispatch?.length || ownPackage() || ownModule()));
  for (const name of ['postgres', 'manticore', 'greenmail']) output(name, cfg.service?.[name] || '');
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await scope(process.argv[2]);
