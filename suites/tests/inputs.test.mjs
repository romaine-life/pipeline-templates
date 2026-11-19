import test from 'node:test';
import assert from 'node:assert/strict';
import {inputs, relevant, matches, changed,pushFiles} from '../inputs.mjs';
import {broad} from '../input-patterns.mjs';
import {releaseInputs} from '../release/inputs.mjs';
import {publishEvent} from '../lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture,run} from '../lib.mjs';

test('narrow checks read their tool\'s files; tests and a merge\'s release read all but docs, manifests and infrastructure', () => {
  for (const [job, patterns] of Object.entries(inputs)) {
    assert.ok(patterns.length, job);
    assert.equal(relevant(['unrelated/video.mp4'], job), broad.includes(job), job);
    if (!['docs.validate','rust.typos'].includes(job)) assert.equal(relevant(['docs/explanation.md'], job), false, job);
    assert.equal(relevant(['assets/embed.txt'], job, ['assets/embed.txt']), true, job);
  }
  assert.deepEqual([...broad].sort(), ['cmake.test','dotnet.test','go.test','python.test','release.build','rust.test','web-app.test']);
  const tests = ['cmd/app/main_test.go','internal/x/testdata/case.json','tests/cli.rs','crate/tests/it.rs','test/fixture.txt','benches/speed.rs','src/app.test.ts','frontend/src/view.spec.js','Tests/Unit/Parse.cs','App/Tests/Run.cs','.gitignore','frontend/.gitignore','.forgejo/workflows/ci.yml'];
  for (const job of broad) {
    for (const file of ['frontend/src/app.ts','scripts/build.mjs','regress/case.sh','probes/probe.rs','.forgejo/container/run.cmd','Cargo.toml']) assert.ok(relevant([file], job), `${job} ${file}`);
    for (const file of ['README.md','frontend/README.md','docs/guide.txt','LICENSE','LICENSE-MIT','k8s/values.yaml','tofu/main.tf']) assert.equal(relevant([file], job), false, `${job} ${file}`);
    assert.ok(relevant(['README.md','src/main.rs'], job), job);
    // A file the repository names as an input (an archived README, a Go embed) counts even there.
    assert.ok(relevant(['README.md'], job, ['README.md']), job);
    // The tests read their own files and the workflows; a merge's release doesn't, since they can't change what it ships.
    for (const file of tests) assert.equal(relevant([file], job), job !== 'release.build', `${job} ${file}`);
  }
  assert.ok(relevant(['internal/x/testdata/embedded.txt'], 'release.build', ['internal/x/testdata/embedded.txt']));
  assert.ok(relevant(['src/app.test.ts','src/app.ts'], 'release.build'));
  // A workflow that builds a release part itself is an input to the release.
  const external = releaseInputs({release: {external: [{id: 'build', workflow: 'build.yml'}]}});
  assert.ok(relevant(['.forgejo/workflows/build.yml'], 'release.build', external));
  assert.equal(relevant(['.forgejo/workflows/checks.yml'], 'release.build', external), false);
});
test('the manifests check reads k8s/, where every render is', () => {
  for (const file of ['k8s/kustomization.yaml','k8s/values-unserved.yaml','k8s/templates/a.yaml']) assert.ok(relevant([file],'cluster-service.manifests'),file);
  assert.equal(relevant(['nas/other.ps1'],'cluster-service.manifests'),false);
});
test('globs include root files, nested files and deletions without a negative catch-all', () => {
  for (const file of ['main.go','cmd/app/main.go']) assert.ok(matches(file, '**/*.go'));
  assert.ok(matches('Cargo.toml', '**/Cargo.toml'));
  assert.ok(matches('k8s/values.yaml', 'k8s/**'));
  assert.equal(matches('k8s-other/values.yaml', 'k8s/**'), false);
  assert.equal(relevant(['old.go'], 'go.test'), true);
  assert.equal(relevant(['tofu/main.tf'], 'go.test'), false);
  assert.equal(relevant(['README.md'], 'tofu.plan'), false);
});
test('missing bases fail instead of running everything', () => assert.throws(() => changed(''), /exact PR base/));
test('tofu push fallback applies only with no before or an all-zero before',()=>{
  assert.equal(pushFiles(''),null);assert.equal(pushFiles('0'.repeat(40)),null);
  assert.throws(()=>pushFiles('not-a-sha'),/invalid push/);
  assert.equal(relevant(['docs/guide.md'],'tofu.plan'),false);
  assert.equal(relevant(['tofu/main.tf'],'tofu.plan'),true);
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
    assert.equal(relevant(pushFiles(before,head),'tofu.plan'),true);
    assert.throws(()=>pushFiles('f'.repeat(40),head),/git exited/);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});
test('web tests read every package and directory, not only the ones a pattern named', () => {
  for (const file of ['frontend/src/app.ts','backend/server.js','other/package.json','src/unrelated.ts','scripts/check.mjs','drizzle/0001.sql']) assert.ok(relevant([file],'web-app.test'),file);
  assert.equal(relevant(['frontend/README.md'],'web-app.test'),false);
});
test('only a default branch push or dispatch publishes, including master', () => {
  assert.ok(publishEvent('push', 'refs/heads/master', 'master'));
  assert.ok(publishEvent('workflow_dispatch', 'refs/heads/main', 'main'));
  for (const event of ['pull_request','schedule','workflow_call']) assert.equal(publishEvent(event,'refs/heads/main','main'), false);
  assert.equal(publishEvent('push','refs/heads/feature','main'), false);
});
