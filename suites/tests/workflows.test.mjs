import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {suites} from '../lib.mjs';
import {nativeJob,workflowJobName} from '../fingerprints.mjs';
test('host jobs never request services, and history is limited to diff consumers',()=>{
  for(const suite of fs.readdirSync(suites,{withFileTypes:true}).filter(d=>d.isDirectory() && !['tests','node_modules'].includes(d.name))){
    for(const file of fs.readdirSync(path.join(suites,suite.name)).filter(f=>f.endsWith('.yml'))){
      const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite.name,file),'utf8'));
      for(const [name,job]of Object.entries(workflow.jobs)){
        assert.equal(job.services,undefined,`${suite.name}/${name}: runner services are forbidden`);
        if(job.steps?.some(step=>step.run==='node _ci/suites/services.mjs start'))assert.ok(job.steps.some(step=>step.run==='node _ci/suites/services.mjs stop' && step.if==='always()'),`${suite.name}/${name}: cleanup after cancellation`);
        for(const step of job.steps || []){
          if(step.with?.['fetch-depth']===0)assert.ok(name==='scope',`${suite.name}/${name}: unnecessary history`);
          // A web app's tests get history only when its entry says they compare with the base.
          if(typeof step.with?.['fetch-depth']==='string')assert.equal(`${suite.name}/${name}:${step.with['fetch-depth']}`,"web-app/check-test:${{ needs.scope.outputs.test-history == 'true' && '0' || '1' }}");
        }
      }
    }
  }
});

test('platform checks are fixed jobs with independent conditions and complete collector dependencies',()=>{
  for(const suite of ['go','rust','cmake','dotnet','python']) {
    const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite,'ci.yml'),'utf8'));
    assert.equal(workflow.jobs['check-test'],undefined);
    for(const [platform,runner] of [['linux','ubuntu-latest'],['windows','windows-latest']]) {
      const name=`check-test-${platform}`,job=workflow.jobs[name];
      assert.equal(job['runs-on'],runner);assert.equal(job.strategy,undefined);assert.equal(job.env,undefined);
      assert.equal(job.if,`github.event_name == 'pull_request' && needs.scope.outputs.test-${platform} == 'true'`);
      assert.equal(workflow.jobs.scope.outputs[`test-${platform}`],`\${{ steps.scope.outputs.test-${platform} }}`);
      assert.ok(workflow.jobs['reused-checks'].needs.includes(name));
    }
  }
  const release=YAML.parse(fs.readFileSync(path.join(suites,'release/ci.yml'),'utf8'));
  for(const name of ['build','check-build'])assert.equal(release.jobs[name].strategy.matrix,'${{ fromJSON(needs.scope.outputs.matrix) }}');
  assert.match(release.jobs.finalize.if,/always\(\)/);assert.match(release.jobs['reused-checks'].if,/always\(\)/);
});

test('PR packaging signs and verifies assembled assets with the merge signer, without publication',()=>{
  const workflow=YAML.parse(fs.readFileSync(path.join(suites,'release/ci.yml'),'utf8'));
  const job=workflow.jobs['check-package'],steps=job.steps;
  assert.match(job.if,/github.event_name == 'pull_request'/);
  const assemble=steps.findIndex(step=>step.run==='node _ci/suites/release/assemble.mjs');
  const sign=steps.findIndex(step=>step.run==='node _ci/suites/release/sign-linux.mjs');
  const smoke=steps.findIndex(step=>step.run==='node _ci/suites/release/image.mjs check');
  assert.ok(assemble>=0 && assemble<sign && sign<smoke);
  const merge=workflow.jobs.finalize.steps.find(step=>step.run==='node _ci/suites/release/sign-linux.mjs');
  for(const key of ['AT_TERMINAL_PFX','AT_TERMINAL_PFX_PASSWORD'])assert.equal(steps[sign].env[key],merge.env[key]);
  assert.equal(steps[sign].env.VERSION,'${{ needs.scope.outputs.check-version }}');
  assert.equal(workflow.jobs['check-build'].steps.find(step=>step.run==='node _ci/suites/release/build.mjs').env.VERSION,steps[sign].env.VERSION);
  assert.equal(steps.some(step=>/\bpublish\b|protocol\.mjs/.test(step.run || '')),false);
  assert.equal(steps[sign].env.TOKEN,undefined);
});

// A published archive's signature names its release tag, which home-sync checks; the
// publishing signer once ran with none and every archive it signed was refused (PIPT-37).
test('the publishing signer signs with the reserved release tag',()=>{
  const workflow=YAML.parse(fs.readFileSync(path.join(suites,'release/ci.yml'),'utf8'));
  const sign=workflow.jobs.finalize.steps.find(step=>step.run==='node _ci/suites/release/sign-linux.mjs');
  assert.equal(sign.env.VERSION,'${{ needs.reserve.outputs.tag }}');
});


test('checks use frozen scripts and the pass recorder waits for every native result',()=>{
  for(const suite of fs.readdirSync(suites,{withFileTypes:true}).filter(dir=>dir.isDirectory() && fs.existsSync(path.join(suites,dir.name,'ci.yml')))) {
    const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite.name,'ci.yml'),'utf8'));
    for(const [name,job] of Object.entries(workflow.jobs).filter(([name])=>name.startsWith('check-'))) {
      assert.equal(job.steps.find(step=>step.with?.path==='_ci').with.ref,'${{ needs.scope.outputs.suite-sha }}');
      assert.ok(workflow.jobs['reused-checks'].needs.includes(name));
      assert.equal(job.steps.some(step=>step.id==='receipt'),false);
    }
    assert.match(workflow.jobs['reused-checks'].if,/always\(\)/);
    assert.ok(workflow.jobs['reused-checks'].steps.some(step=>step.run==='node _ci/suites/reuse.mjs publish'));
  }
});

test('every Windows suite command and PowerShell composite step suppresses profiles and interaction',()=>{
  function safe(shell,where) {
    if(shell?.includes('${{')){const match=shell.match(/windows-latest' && '((?:[^']|'')*)' \|\|/);assert.ok(match,where);shell=match[1].replaceAll("''", "'");}
    assert.match(shell || '',/^(?:pwsh|powershell)\s/,where);
    assert.match(shell,/-NoProfile\b/i,where);assert.match(shell,/-NonInteractive\b/i,where);
  }
  for(const suite of fs.readdirSync(suites,{withFileTypes:true}).filter(d=>d.isDirectory() && fs.existsSync(path.join(suites,d.name,'ci.yml')))) {
    const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite.name,'ci.yml'),'utf8'));
    for(const [name,job] of Object.entries(workflow.jobs))if(String(job['runs-on']).includes('windows') || job.strategy?.matrix)for(const step of job.steps || [])if(step.run)safe(step.shell || job.defaults?.run?.shell || workflow.defaults?.run?.shell,`${suite.name}/${name}`);
  }
  const actions=path.join(suites,'../actions');
  for(const dir of fs.readdirSync(actions)) {
    const file=path.join(actions,dir,'action.yml');if(!fs.existsSync(file))continue;
    const action=YAML.parse(fs.readFileSync(file,'utf8'));
    for(const step of action.runs?.steps || [])if(/^pwsh\b|^powershell\b/.test(step.shell || ''))safe(step.shell,file);
  }
});


test('matrix display names and cache provenance identify only toolchain and target',()=>{
  for(const suite of ['go','rust','cmake','dotnet','python']) {
    const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite,'ci.yml'),'utf8'));
    for(const runner of ['ubuntu-latest','windows-latest'])assert.equal(workflowJobName(workflow,runner==='windows-latest'?'check-test-windows':'check-test-linux'),nativeJob(`${suite}.test`,runner));
  }
  const release=YAML.parse(fs.readFileSync(path.join(suites,'release/ci.yml'),'utf8'));
  assert.equal(release.jobs.build.name,'build (${{ matrix.toolchain }}, ${{ matrix.target || matrix.runner }})');
  assert.equal(release.jobs['check-build'].name,'check-build (${{ matrix.toolchain }}, ${{ matrix.target || matrix.runner }})');
});

test('every pin publisher and dependency PR uses PIPELINE_DISPATCH_TOKEN to open and queue it',()=>{
  for(const suite of ['cluster-service','web-app','release']) {
    const workflow=YAML.parse(fs.readFileSync(path.join(suites,suite,'ci.yml'),'utf8'));
    for(const job of Object.values(workflow.jobs))for(const step of job.steps || []) {
      if(/(?:(?:cluster-service\/pin|web-app\/deploy|release\/deploy)\.mjs)$/.test(step.run || ''))assert.equal(step.env?.PIN_TOKEN,'${{ secrets.PIPELINE_DISPATCH_TOKEN }}',`${suite}: ${step.run}`);
    }
  }
  const dependencies=YAML.parse(fs.readFileSync(path.join(suites,'go/dependencies.yml'),'utf8'));
  assert.equal(dependencies.jobs.update.steps.find(step=>step.run==='node _ci/suites/go/dependencies.mjs').env.TOKEN,'${{ secrets.PIPELINE_DISPATCH_TOKEN }}');
  for(const suite of ['web-app','release']) {
    const takeUp=YAML.parse(fs.readFileSync(path.join(suites,suite,'dependencies.yml'),'utf8'));
    assert.equal(takeUp.jobs.update.steps.find(step=>step.run==='node _ci/suites/packages.mjs take-up').env.TOKEN,'${{ secrets.PIPELINE_DISPATCH_TOKEN }}',suite);
  }
});
test('a release dispatches its downstream workflows once: publish does it, or the dispatch job after home-sync publishes',()=>{
  const jobs=YAML.parse(fs.readFileSync(path.join(suites,'release/ci.yml'),'utf8')).jobs;
  assert.match(jobs.publish.if,/home-sync != 'true'/);
  assert.ok(jobs.publish.steps.some(step=>step.run==='node _ci/suites/release.mjs publish'));
  assert.match(jobs.dispatch.if,/home-sync == 'true'/);
});
