import test from 'node:test';
import assert from 'node:assert/strict';
import {violations} from '../default/rules.mjs';
const valid = `on: [pull_request, push, workflow_dispatch]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  check-test:
    if: github.event_name == 'pull_request' && needs.scope.outputs.code == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: go test ./...
  build:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: go build ./cmd/...
`;
test('PR-only check and default-branch build are accepted', () => assert.deepEqual(violations(valid), []));
test('push checks, trigger filters, unsafe concurrency and polls are rejected', () => {
  const cases = [
    [valid.replace("github.event_name == 'pull_request' && needs.scope.outputs.code == 'true'", 'true'), /check must/],
    [valid.replace('on: [pull_request, push, workflow_dispatch]', 'on:\n  pull_request:\n    paths: [src/**]'), /trigger paths/],
    [valid.replace("${{ github.event_name == 'pull_request' }}", 'false'), /cancel exactly/],
    [valid.replace('ci-${{ github.ref }}', 'ci'), /isolate PRs/],
    [valid.replace('go build ./cmd/...', 'for n in 1 2; do curl api; sleep 30; done'), /loop waits/],
    [valid.replace('go build ./cmd/...', 'gh run watch 1'), /polling/],
    [valid.replace('on: [pull_request, push, workflow_dispatch]', 'on:\n  schedule: [{cron: "0 0 * * *"}]'), /scheduled/],
    [valid.replace("github.event_name == 'pull_request' && needs.scope.outputs.code == 'true'", "github.event_name == 'pull_request' || true"), /check must/],
    [valid.replace('go build ./cmd/...', 'node scripts/entry.mjs'), /check must/, p => p === 'scripts/entry.mjs' ? 'go test ./...' : null],
    [valid.replace('go build ./cmd/...', 'bash ci/deploy.sh'), /loop waits/, p => p === 'ci/deploy.sh' ? 'while true; do sleep 30; done' : null]
  ];
  for (const [text, expected, read] of cases) assert.match(violations(text, read).join('\n'), expected);
});
test("a suite script a repository's workflow runs from _ci is not the repository's", () => {
  const read = p => p.startsWith('_ci/') ? 'while true; do sleep 30; done; node poll.mjs' : null;
  assert.deepEqual(violations(valid.replace('go build ./cmd/...', 'node _ci/suites/inputs.mjs release'), read), []);
  assert.deepEqual(violations(valid.replace('go build ./cmd/...', 'node ./_ci/suites/release/complete-external.mjs'), read), []);
});
test('a URL query parameter named poll is a single read, not polling', () => {
  assert.deepEqual(violations(valid.replace('go build ./cmd/...', 'curl -sf "http://$address/alerts/json?poll=1"')), []);
  assert.match(violations(valid.replace('go build ./cmd/...', 'node poll.mjs')).join('\n'), /polling/);
});
test('comment lines are neither commands nor references to scripts', () => {
  const sources = {'scripts/serve.sh': '# deploy.sh waits until Argo CD has synced\ncurl -sf http://x/health', 'deploy.sh': 'for _ in 1 2; do sleep 5; done'};
  assert.deepEqual(violations(valid.replace('go build ./cmd/...', 'scripts/serve.sh'), p => sources[p] ?? null), []);
  assert.match(violations(valid.replace('go build ./cmd/...', 'bash deploy.sh'), p => sources[p] ?? null).join('\n'), /loop waits/);
});
test('a sleep counts as a poll only inside a loop', async () => {
  const {loopWaits} = await import('../default/rules.mjs');
  for (const [commands, polls] of [
    ['for key in a b; do curl -X PATCH x; done\ntouch /tmp/cut\nsleep 2', false],
    ['until curl -sf x; do sleep 1; done', true],
    ['for _ in $(seq 30); do check && break; sleep 2; done', true],
    ['while true\ndo\n  if ready; then break; fi\n  sleep 5\ndone', true],
    ['import time\nfor x in xs:\n    if x:\n        time.sleep(1)', true],
    ['import time\nprepare()\ntime.sleep(1)\nfor x in xs:\n    print(x)', false],
    ['while ($true) { Start-Sleep 5 }', true],
  ]) assert.equal(loopWaits(commands), polls, commands);
});
test('a request counts as a poll only in a shell loop', async () => {
  const {shellLoopRequest} = await import('../default/rules.mjs');
  for (const [commands, polls] of [
    ['until curl -sf http://x/health; do echo waiting; done', true],
    ['while ! wget -q http://x; do :; done', true],
    ['for key in $(curl -s http://x/keys); do\n  curl -X PATCH http://x/$key\ndone', false],
    ['while true; do\n  for i in 1 2; do echo $i; done\n  curl -sf http://x && break\ndone', true],
    ['while (off < end) { off += 10; }\nconst response = await fetch(url);', false],
    ['curl -sf http://x/health\nfor f in *.json; do jq empty "$f"; done', false],
  ]) assert.equal(shellLoopRequest(commands), polls, commands);
});
test('relative imported helper scripts remain covered by the rules', () => {
  const sources={'ci/deploy.mjs':"import './nested/wait.mjs'",'ci/nested/wait.mjs':'while (true) { setTimeout(fn, 3000); }'};
  assert.match(violations(valid.replace('go build ./cmd/...','node ci/deploy.mjs'),p=>sources[p] ?? null).join('\n'),/loop waits/);
});
test('duplicate YAML keys cannot hide a trigger', () => assert.match(violations('on: push\non: pull_request').join(''), /unique/i));

// actionlint runs over a repository's own workflows: a context Forgejo would refuse only
// when it runs the workflow fails the rules check on the pull request instead.
test('a repository workflow Forgejo would refuse fails the rules check', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const script = new URL('../default/rules.mjs', import.meta.url);
  const workflow = env => `on:\n  pull_request:\nconcurrency:\n  group: checks-\${{ github.ref }}\n  cancel-in-progress: \${{ github.event_name == 'pull_request' }}\njobs:\n  check-x:\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n${env}    steps:\n      - run: echo hi\n`;
  for (const [env, ok] of [['', true], ['    env:\n      DIR: ${{ runner.tool_cache }}/x\n', false]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
    try {
      fs.mkdirSync(path.join(root, '.forgejo', 'workflows'), {recursive: true});
      fs.writeFileSync(path.join(root, '.forgejo', 'workflows', 'checks.yml'), workflow(env));
      spawnSync('git', ['init', '-q'], {cwd: root});
      spawnSync('git', ['add', '-A'], {cwd: root});
      const result = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1')], {cwd: root, encoding: 'utf8'});
      assert.equal(result.status === 0, ok, result.stdout + result.stderr);
      if (!ok) assert.match(result.stdout + result.stderr, /context "runner" is not allowed here/);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  }
});
