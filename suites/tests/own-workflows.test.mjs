import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {condition, planWorkflow, runOwn, starts, words} from '../own-workflows.mjs';
import {templates} from '../lib.mjs';

test('a pull request starts a workflow as its trigger and filters say', () => {
  assert.equal(starts('pull_request', [], 'main'), true);
  assert.equal(starts(['push', 'pull_request'], [], 'main'), true);
  assert.equal(starts({push: {branches: ['main']}}, ['a'], 'main'), false);
  assert.equal(starts({pull_request: {types: ['closed']}}, ['a'], 'main'), false);
  assert.equal(starts({pull_request: {paths: ['src/**', '!src/docs/**']}}, ['src/docs/a.md'], 'main'), false);
  assert.equal(starts({pull_request: {paths: ['src/**', '!src/docs/**']}}, ['src/docs/a.md', 'src/a.go'], 'main'), true);
  assert.equal(starts({pull_request: {'paths-ignore': ['**.md']}}, ['README.md'], 'main'), false);
  assert.equal(starts({pull_request: {branches: ['release/*']}}, ['a'], 'main'), false);
});

test('conditions read the expressions workflows use, and name what a PC does not know', () => {
  assert.equal(condition("always() && !cancelled() && (needs.a.outputs.x == 'true' || github.event_name == 'push')").status, true);
  assert.equal(condition("needs.scope.outputs.code == 'true'").status, false);
  assert.match(condition('github.actor_id == 1').why, /reads github.actor_id/);
  assert.match(condition("secrets.TOKEN != ''").why, /needs the secret TOKEN/);
  assert.match(condition("hashFiles('x') != ''").why, /calls hashFiles/);
});

test("a custom shell line splits as the runner's does", () => {
  const line = `pwsh -NoLogo -Command "$ErrorActionPreference = 'Stop'; . ([scriptblock]::Create([IO.File]::ReadAllText('{0}')))"`;
  assert.deepEqual(words(line), ['pwsh', '-NoLogo', '-Command', "$ErrorActionPreference = 'Stop'; . ([scriptblock]::Create([IO.File]::ReadAllText('{0}')))"]);
});

// The case ci-check missed (AHT-168): pipeline-templates' own suite tests, run by its CI on
// both systems, ran nowhere before a push.
test("this repository's own suite tests run here on either system, the other system's job named as its twin", () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(templates, '.forgejo/workflows/ci.yml'), 'utf8'));
  for (const [platform, here, there] of [['win32', 'suite-tests-windows', 'suite-tests-linux'], ['linux', 'suite-tests-linux', 'suite-tests-windows']]) {
    const plan = Object.fromEntries(planWorkflow(workflow, {root: templates, repository: 'romaine-life/pipeline-templates', platform}).map(j => [j.id, j]));
    assert.equal(plan[here].why, null, `${here} on ${platform}`);
    assert.match(plan[there].why, new RegExp(`${here} runs the same steps here`));
    assert.equal(plan.changes.why, null);
    assert.match(plan['home-cache-windows'].why, /sets up the runner's machine/);
  }
});

test("every pull-request job of a repository's own workflows runs or is named, and a failing one fails", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'own-workflows-'));
  const git = (...args) => { const r = spawnSync('git', args, {cwd: repo, encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci');
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true}); fs.writeFileSync(path.join(repo, file), text); };
  write('gate.mjs', "import fs from 'node:fs'; fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${process.env.BASE ? 'true' : 'false'}\\n`);\n");
  write('test.mjs', "import fs from 'node:fs'; if (fs.existsSync('broken')) { console.error('broken'); process.exit(1); }\n");
  const checkout = {uses: 'actions/checkout@v4'};
  const tests = os => ({needs: 'changes', if: "needs.changes.outputs.code == 'true'", 'runs-on': os, steps: [checkout, {run: 'node test.mjs'}]});
  write('.forgejo/workflows/ci.yml', YAML.stringify({
    name: 'CI',
    on: {pull_request: {types: ['opened', 'synchronize']}, push: {branches: ['main']}},
    jobs: {
      changes: {'runs-on': 'ubuntu-latest', outputs: {code: '${{ steps.diff.outputs.code }}'},
        steps: [{...checkout, with: {'fetch-depth': 0}}, {uses: 'romaine-life/pipeline-templates/actions/setup-node@main'}, {id: 'diff', run: 'node gate.mjs'}]},
      'tests-linux': tests('ubuntu-latest'),
      'tests-windows': tests('windows-latest'),
      docs: {needs: 'changes', if: "needs.changes.outputs.docs == 'true'", 'runs-on': 'ubuntu-latest', steps: [{run: 'node test.mjs'}]},
      publish: {'runs-on': 'ubuntu-latest', steps: [{run: 'node test.mjs', env: {TOKEN: '${{ secrets.TOKEN }}'}}]},
      lint: {'runs-on': 'ubuntu-latest', steps: [{uses: 'someone/lint@v1'}]},
    },
  }));
  write('.forgejo/workflows/release.yml', YAML.stringify({name: 'Release', on: {push: {branches: ['main']}}, jobs: {build: {'runs-on': 'ubuntu-latest', steps: [{run: 'exit 1'}]}}}));
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const here = process.platform === 'win32' ? 'windows' : 'linux', there = here === 'windows' ? 'linux' : 'windows';
  const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
  const check = () => quiet(() => runOwn({root: repo, repository: 'test/own', base, branch: 'main', files: ['test.mjs'], platform: process.platform}));

  let result = check();
  assert.deepEqual({ran: result.ran, failed: result.failed}, {ran: 2, failed: []});
  assert.deepEqual(result.skipped.sort(), [
    'CI / lint: uses someone/lint@v1',
    'CI / publish: needs the secret TOKEN',
    `CI / tests-${there}: runs on ${there === 'linux' ? 'ubuntu' : 'windows'}-latest; tests-${here} runs the same steps here`,
  ]);

  write('broken', '');
  result = check();
  assert.deepEqual(result.failed, [`CI / tests-${here}: a step failed`]);
  fs.rmSync(repo, {recursive: true, force: true});
});
