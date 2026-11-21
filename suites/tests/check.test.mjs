import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {ciOnly, command, condition, plan} from '../check.mjs';
import {suiteNames} from '../config.mjs';
import {suites} from '../lib.mjs';

test('ci-check can read every suite check job: its condition and each command, or why a PC skips it', () => {
  const jobs = new Set();
  for (const suite of suiteNames) {
    for (const [id, job] of Object.entries(YAML.parse(fs.readFileSync(path.join(suites, suite, 'ci.yml'), 'utf8')).jobs)) {
      if (!id.startsWith('check-')) continue;
      jobs.add(`${suite}/${id}`);
      condition(job.if);
      if (!ciOnly[`${suite}/${id}`]) for (const step of job.steps.filter(s => s.run)) command(step);
    }
  }
  for (const name of Object.keys(ciOnly)) assert.ok(jobs.has(name), `${name} is not a suite check job`);
});

test('the jobs a change starts are the ones whose scope outputs it sets, on their own platform', () => {
  const names = jobs => jobs.map(j => j.skip ? `${j.name} (skip)` : j.name);
  const go = {format: 'true', 'test-linux': 'true', 'test-windows': 'true', 'service-test': 'false', 'has-services': 'false'};
  assert.deepEqual(names(plan('go', go, {}, 'win32')), ['go/check-format', 'go/check-test-linux (skip)', 'go/check-test-windows']);
  assert.deepEqual(names(plan('go', go, {}, 'linux')), ['go/check-format', 'go/check-test-linux', 'go/check-test-windows (skip)']);
  assert.deepEqual(names(plan('go', {...go, format: 'false', 'test-windows': 'false'}, {}, 'linux')), ['go/check-test-linux']);
  // A web app's tests are a job per npm package whose inputs changed, each with its folder.
  const web = {test: 'true', 'test-packages': JSON.stringify({package: ['backend', 'frontend']})};
  assert.deepEqual(names(plan('web-app', web, {service: {postgres: 'postgres@sha256:0'}})), ['web-app/check-test (backend) (skip)', 'web-app/check-test (frontend) (skip)']);
  const [backend, frontend] = plan('web-app', web, {});
  assert.deepEqual(backend.steps.map(s => [path.basename(s.args[0]), s.args.slice(1), s.env, s.always]),
    [['services.mjs', ['start'], {}, false], ['test.mjs', [], {TEST_PACKAGE: 'backend'}, false], ['services.mjs', ['stop'], {}, true]]);
  assert.equal(frontend.name, 'web-app/check-test (frontend)');
  assert.deepEqual(frontend.steps[1].env, {TEST_PACKAGE: 'frontend'});
  assert.equal(plan('release', {build: 'true', 'has-local': 'true'}, {}).every(j => j.skip), true);
});

test('a PowerShell step runs in the PowerShell its job names', () => {
  assert.equal(command({run: './_ci/suites/powershell/parse.ps1', shell: 'powershell -NoLogo'}).file, 'powershell');
  assert.equal(command({run: './_ci/suites/powershell/parse.ps1'}).file, 'pwsh');
  assert.throws(() => command({run: 'curl https://example.com | sh'}), /can't run the step/);
  assert.throws(() => condition("needs.scope.outputs.x != 'true'"), /can't read the job condition/);
});

test('ci-check runs the docs suite on the commits since the default branch and fails on what CI would', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-check-'));
  const repo = path.join(root, 'work');
  const git = (...args) => { const r = spawnSync('git', args, {cwd: repo, encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Probe\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const from = git('rev-parse', 'HEAD');
  const fleet = path.join(root, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({repos: {'test/check': {suites: ['docs']}}}));
  const env = {...process.env, CI_FLEET: fleet, CI_TOPICS: '[]', CI_REPOSITORY: 'test/check'};
  for (const name of ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT', 'BASE']) delete env[name];
  const script = `import {check} from ${JSON.stringify(new URL('../check.mjs', import.meta.url).href)}; await check({from: ${JSON.stringify(from)}, platform: 'linux'});`;
  const runCheck = () => spawnSync(process.execPath, ['--input-type=module', '-e', script], {cwd: repo, env, encoding: 'utf8'});

  fs.writeFileSync(path.join(repo, 'README.md'), '# Probe\n\nSee [the guide](guide.md).\n');
  git('commit', '-qam', 'link a missing page');
  let result = runCheck();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /== docs\/check-validate/);
  assert.match(result.stdout, /failed {2}docs\/check-validate: .*exited 1/);

  fs.writeFileSync(path.join(repo, 'guide.md'), '# Guide\n');
  git('add', '.'); git('commit', '-qm', 'add the page');
  result = runCheck();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ci-check: 1 check job\(s\) ran, all passed\./);
  fs.rmSync(root, {recursive: true, force: true});
});
