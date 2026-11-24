import test from 'node:test';
import assert from 'node:assert/strict';
import {goViolations, violations} from '../default/rules.mjs';
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
test('a step that waits on purpose says why', () => {
  const loop = 'for n in 1 2; do sleep 30; done';
  assert.match(violations(valid.replace('go build ./cmd/...', loop)).join('\n'), /loop waits/);
  const script = why => valid.replace('go build ./cmd/...', `|\n          # waits:${why}\n          ${loop}`);
  assert.doesNotMatch(violations(script(' each PC reports its run')).join('\n'), /loop waits/);
  assert.match(violations(script('')).join('\n'), /loop waits/);
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
    ['foreach ($i in 1..30) {\n  if (Test-Ready) { break }\n  Start-Sleep 2\n}', true],
    ['Start-Sleep 5\nforeach ($f in $files) { Write-Output $f }', false],
    ['for (let i = 0; i < 30; i++) {\n  if (await ready()) break;\n  await new Promise(r => setTimeout(r, 1000));\n}', true],
    ['const sleep = ms => new Promise(r => setTimeout(r, ms));\nwhile (!(await ready())) { await sleep(1000); }', true],
    ["import {setTimeout as delay} from 'node:timers/promises';\nfor (;;) { await delay(500); }", true],
    ["const {setTimeout: pause} = require('node:timers/promises');\nfor (let i = 1; ; i++) { await pause(500); }", true],
    ['socket.setTimeout(3000, () => socket.destroy());\nfor (const port of ports) { await probe(port); }', false],
    ['const deadline = setTimeout(() => reject(new Error("late")), 240000);\nfor (const line of lines) { if (line) resolve(); }', false],
    ['while (queue.length) { await handle(queue.shift()); }\nrequest.setTimeout(300000, () => request.destroy());', false],
    ['for (const f of files) load(f);\ntry { timer = setTimeout(() => reject(new Error("late")), 1000); } finally {}', false],
    ['while (!(await ready())) await new Promise(r => setTimeout(r, 1000));', true],
    ['for (const {name} of jobs) { await new Promise(r => setTimeout(r, 1000)); }', true],
    ['const shell = "for port in 1 2; do nc -z $port; done { x }";\nconst t = setTimeout(() => fail(), 1000);', false],
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
test("a Go repository's own workflow that builds its Go is refused; one without go.mod, or installing a published tool, isn't", () => {
  const go = {go: true};
  assert.match(violations(valid, null, go).join('\n'), /build: builds the repository's Go/);
  assert.match(violations(valid.replace('go build ./cmd/...', 'go install ./cmd/tool'), null, go).join('\n'), /builds the repository's Go/);
  assert.match(violations(valid.replace('go build ./cmd/...', 'bash scripts/ship.sh'), p => p === 'scripts/ship.sh' ? 'GOOS=windows go build -o x.exe .' : null, go).join('\n'), /builds the repository's Go/);
  assert.deepEqual(violations(valid.replace('go build ./cmd/...', 'go install golang.org/x/tools/cmd/stringer@v0.30.0'), null, go), []);
  assert.deepEqual(violations(valid), [], 'nelsong6/forgejo builds upstream Go with no go.mod of its own');
});
test('a Go repository takes the go suite, and a released Go program is built by the release', () => {
  const read = p => ({'main.go': 'package main\n', 'lib.go': 'package lib\n'})[p] ?? null;
  assert.deepEqual(goViolations([], ['README.md'], read), [], 'no go.mod, no Go rules');
  assert.deepEqual(goViolations(['ci-go'], ['go.mod', 'lib.go'], read), []);
  assert.match(goViolations([], ['go.mod', 'lib.go'], read).join('\n'), /go\.mod: a Go repository takes the go suite/);
  assert.deepEqual(goViolations([], ['go.mod', '.github/workflows/forgejo-sync.yml'], read), [], "a Forgejo copy of a GitHub repository is built on GitHub");
  const released = ['go.mod', 'cmd/tool/main.go', 'cmd/tool/main_test.go', 'cmd/notes/README.md', 'main.go'];
  assert.deepEqual(goViolations(['ci-go', 'ci-release', 'release-dotnet'], released, read), [
    ".: a Go program the release doesn't build (release-go, and a build for it in .goreleaser.yaml)",
    "cmd/tool: a Go program the release doesn't build (release-go, and a build for it in .goreleaser.yaml)"]);
  assert.deepEqual(goViolations(['ci-go', 'ci-release', 'release-go'], released, read), []);
  assert.deepEqual(goViolations(['ci-go', 'ci-release', 'release-module'], ['go.mod', 'lib.go'], read), []);
  assert.deepEqual(goViolations(['ci-go', 'ci-release', 'release-dotnet'], ['go.mod', 'lib.go'], read), [], 'a library is no program');
});
test("a repository's own workflow never cuts a release, whatever its language", () => {
  const step = s => valid.replace('      - run: go build ./cmd/...', s);
  const cut = [
    '      - uses: romaine-life/pipeline-templates/actions/release-version@main\n        with:\n          publish: "true"',
    '      - uses: ./_ci/actions/release-version',
    '      - uses: softprops/action-gh-release@v2',
    '      - run: gh release create v1.2.3 dist/*',
    '      - run: Invoke-RestMethod "$api/releases" -Method Post -Body $body',
    '      - run: |\n          Invoke-RestMethod "$api/releases/$id/assets?name=x" `\n            -Method Post -Form @{attachment = $f}',
    '      - run: |\n          curl -X POST \\\n            "$API/repos/o/r/releases" -d "{}"',
    '      - run: |\n          curl -fsS -H "Authorization: token $T" -F attachment=@x.exe "$API/releases/7/assets"'
  ];
  for (const s of cut) assert.match(violations(step(s)).join('\n'), /build: cuts a release/, s);
  assert.match(violations(step('      - run: ./ci/ship.ps1'), p => p === 'ci/ship.ps1' ? 'Invoke-RestMethod "$api/releases" -Method Post' : null).join('\n'), /cuts a release/, 'a script the step runs counts');
  const reads = [
    '      - uses: ./_ci/actions/release-version\n        with:\n          publish: "false"',
    '      - run: curl -fsSL https://artifacts.home.romaine.life/general/github/x/y/releases/download/v1/y.tar.gz | tar -xz',
    '      - run: Invoke-RestMethod "$api/releases/latest" -Headers $h',
    '      - run: node _ci/suites/release/complete-external.mjs'
  ];
  for (const s of reads) assert.doesNotMatch(violations(step(s)).join('\n'), /cuts a release/, s);
});
