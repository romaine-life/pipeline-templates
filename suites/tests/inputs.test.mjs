import test from 'node:test';
import assert from 'node:assert/strict';
import {inputs, relevant, matches, changed,pushFiles} from '../inputs.mjs';
import {publishEvent} from '../lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture,run} from '../lib.mjs';

test('every check declares positive dependencies and ignores unrelated inputs', () => {
  for (const [job, patterns] of Object.entries(inputs)) {
    assert.ok(patterns.length, job);
    assert.equal(relevant(['unrelated/video.mp4'], job, {}), false, job);
    if (!['docs.validate','rust.typos'].includes(job)) assert.equal(relevant(['docs/explanation.md'], job, {}), false, job);
    assert.equal(relevant(['assets/embed.txt'], job, {inputs: {[job]: ['assets/embed.txt']}}), true, job);
  }
});
test('globs include root files, nested files and deletions without a negative catch-all', () => {
  for (const file of ['main.go','cmd/app/main.go']) assert.ok(matches(file, '**/*.go'));
  assert.ok(matches('Cargo.toml', '**/Cargo.toml'));
  assert.ok(matches('k8s/values.yaml', 'k8s/**'));
  assert.equal(matches('k8s-other/values.yaml', 'k8s/**'), false);
  assert.equal(relevant(['old.go'], 'go.test', {}), true);
  assert.equal(relevant(['tofu/main.tf'], 'go.test', {}), false);
  assert.equal(relevant(['README.md'], 'tofu.plan', {}), false);
});
test('missing bases fail instead of running everything', () => assert.throws(() => changed(''), /exact PR base/));
test('tofu push fallback applies only with no before or an all-zero before',()=>{
  assert.equal(pushFiles(''),null);assert.equal(pushFiles('0'.repeat(40)),null);
  assert.throws(()=>pushFiles('not-a-sha'),/invalid push/);
  assert.equal(relevant(['docs/guide.md'],'tofu.plan',{}),false);
  assert.equal(relevant(['tofu/main.tf'],'tofu.plan',{}),true);
});
test('push inputs include infrastructure reverted by a replacement head',()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'push-inputs-'));
  try {
    process.chdir(dir);run('git',['init','-b','main']);
    fs.mkdirSync('tofu');fs.writeFileSync('tofu/main.tf','base');
    const commit=()=>{run('git',['add','.']);run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);return capture('git',['rev-parse','HEAD']);};
    const base=commit();fs.writeFileSync('tofu/main.tf','updated');const before=commit();
    run('git',['checkout','-b','replacement',base]);fs.writeFileSync('README.md','docs');const head=commit();
    assert.deepEqual(pushFiles(before,head).sort(),['README.md','tofu/main.tf']);
    assert.equal(relevant(pushFiles(before,head),'tofu.plan',{}),true);
    assert.throws(()=>pushFiles('f'.repeat(40),head),/git exited/);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});
test('web checks name their package sources rather than unrelated packages or docs', () => {
  const cfg={web:{packages:['frontend','backend']}};
  assert.ok(relevant(['frontend/src/app.ts'],'web-app.test',cfg));
  assert.equal(relevant(['frontend/README.md'],'web-app.test',cfg),false);
  assert.equal(relevant(['other/package.json'],'web-app.test',cfg),false);
  assert.equal(relevant(['src/unrelated.ts'],'web-app.test',cfg),false);
});
test('only a default branch push or dispatch publishes, including master', () => {
  assert.ok(publishEvent('push', 'refs/heads/master', 'master'));
  assert.ok(publishEvent('workflow_dispatch', 'refs/heads/main', 'main'));
  for (const event of ['pull_request','schedule','workflow_call']) assert.equal(publishEvent(event,'refs/heads/main','main'), false);
  assert.equal(publishEvent('push','refs/heads/feature','main'), false);
});
