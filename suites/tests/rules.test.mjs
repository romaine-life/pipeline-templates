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
test('relative imported helper scripts remain covered by the rules', () => {
  const sources={'ci/deploy.mjs':"import './nested/wait.mjs'",'ci/nested/wait.mjs':'while (true) { setTimeout(fn, 3000); }'};
  assert.match(violations(valid.replace('go build ./cmd/...','node ci/deploy.mjs'),p=>sources[p] ?? null).join('\n'),/loop waits/);
});
test('duplicate YAML keys cannot hide a trigger', () => assert.match(violations('on: push\non: pull_request').join(''), /unique/i));
