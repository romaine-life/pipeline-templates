import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config, fleet, validate} from '../config.mjs';
import {currentTopics, resolve, settingTopics, validTopic} from '../topics.mjs';
import {checkVariants} from '../fingerprints.mjs';
import {topicsFor} from '../fleet.mjs';

test('unknown settings and unsafe paths fail visibly', () => {
  for (const bad of [{}, {suites: ['nope']}, {suites: ['default']}, {suites: ['go', 'go']}, {suites: [], go: {command: 'whatever'}},
    {suites: [], inputs: {'go.test': ['assets/**']}}, {suites: [], go: {platforms: ['windows-latest']}}, {suites: [], release: {homeSync: true}},
    {suites: ['release'], topics: ['release-go', 'version-from-manifest'], release: {prefix: 'v0.1', prefixFrom: 'Cargo.toml'}},
    ...[[], {}, {'release.tag': 'command'}, {'__proto__.tag': 'tag'}].map(pinFields => ({suites: [], cluster: {pinFile: 'k8s/values.yaml', pinFields}})),
    {suites: [], web: {pinFields: {'release.tag': 'tag'}}}]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validate({suites: ['go'], topics: ['go-test-windows', 'go-test-linux']}).suites, ['go']);
  assert.equal(validate({suites: [], cluster: {pinFile: 'k8s/values.yaml', pinFields: {'release.tag': 'tag', 'release.commit': 'commit', 'release.version': 'version'}}}).cluster.pinFields['release.commit'], 'commit');
});

test('setting topics are Forgejo topics, never a suite, and the list holds only them', () => {
  for (const topic of settingTopics) assert.ok(validTopic(topic) && !topic.startsWith('ci-'), topic);
  for (const topics of [['ci-go'], ['game'], ['go-race', 'go-race'], 'go-race']) assert.throws(() => validate({suites: ['go'], topics}), JSON.stringify(topics));
  assert.throws(() => validate({suites: ['go'], topics: settingTopics.slice(0, 25)}), /25 topics/);
});

test('a selected value is in the list exactly when its topic is', () => {
  const image = `artifacts.home.romaine.life/dockerhub/library/postgres:17@sha256:${'a'.repeat(64)}`;
  validate({suites: ['go'], topics: ['service-postgres'], service: {postgres: image}});
  for (const bad of [{suites: ['go'], service: {postgres: image}}, {suites: ['go'], topics: ['service-postgres']},
    {suites: ['web-app'], topics: ['web-static'], web: {resourceGroup: 'rg'}}, {suites: ['web-app'], web: {staticApp: 'app', resourceGroup: 'rg'}},
    {suites: ['cluster-service'], topics: ['cluster-image']}, {suites: ['cluster-service'], cluster: {image: 'forgejo.romaine.life/o/app'}},
    {suites: ['release'], topics: ['release-rust'], release: {rustTargets: [{target: 'x86_64-unknown-linux-gnu', glibc: '2.35'}]}},
    {suites: ['release'], topics: ['release-rust', 'rust-build-linux-amd64'], release: {rustTargets: [{target: 'x86_64-unknown-linux-gnu'}]}}]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
});

test('topics select the settings the suites read', () => {
  const cfg = resolve({suites: ['cluster-service', 'go', 'release', 'rust', 'powershell'], release: {rustTargets: [{target: 'x86_64-unknown-linux-gnu', glibc: '2.35'}]}, service: {postgres: 'image'}},
    ['go-test-windows', 'rust-test-linux', 'rust-test-windows', 'go-race', 'rust-audit', 'rust-typos', 'windows-powershell', 'release-rust', 'release-go', 'home-sync',
      'version-four-part', 'rust-build-linux-amd64', 'rust-build-windows-amd64', 'game', 'ci-go']);
  assert.deepEqual(cfg.go, {platforms: ['windows-latest'], race: ['./...']});
  assert.deepEqual(cfg.rust, {platforms: ['ubuntu-latest', 'windows-latest'], lints: ['typos', 'audit']});
  assert.deepEqual(cfg.release, {toolchains: ['go', 'rust'], homeSync: true, suffix: '.0',
    rustTargets: [{target: 'x86_64-pc-windows-msvc'}, {target: 'x86_64-unknown-linux-gnu', glibc: '2.35'}]});
  assert.deepEqual(cfg.powershell, {windowsPowerShell: true});
  // Without cluster-image a cluster service builds no image; without service-postgres the
  // tests get no database.
  assert.deepEqual(cfg.cluster, {build: false, smoke: false});
  assert.equal(cfg.service, undefined);
  assert.ok(!cfg.topics.includes('game') && !cfg.topics.includes('ci-go'));
  // No topic: tests on Linux, no lints, no release builds.
  const bare = resolve({suites: ['go', 'rust', 'release']}, []);
  assert.deepEqual(bare, {suites: ['go', 'rust', 'release'], topics: []});
  assert.deepEqual(checkVariants('rust', bare).map(c => c.key), ['rust.format/ubuntu-latest', 'rust.test/ubuntu-latest']);
  assert.throws(() => resolve({suites: ['web-app']}, ['web-image']), /web-image needs web.image/);
});

test('a repository reads its own entry from the fleet list with its live topics, and one it leaves out has no suites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  const file = path.join(dir, 'fleet.json');
  const saved = process.env.CI_TOPICS;
  try {
    fs.writeFileSync(file, JSON.stringify({repos: {'o/one': {suites: ['go'], topics: ['go-test-windows']}}}));
    const repos = fleet(file);
    // The topics the repository carries when it runs decide, not the list's.
    assert.deepEqual(config('o/one', repos, ['go-test-windows']).go.platforms, ['windows-latest']);
    assert.equal(config('o/one', repos, []).go, undefined);
    delete process.env.CI_TOPICS;
    assert.throws(() => config('o/one', repos), /topics weren't read/);
    process.env.CI_TOPICS = '["go-test-windows","go-test-linux"]';
    assert.deepEqual(config('o/one', repos).go.platforms, ['ubuntu-latest', 'windows-latest']);
    assert.deepEqual(config('o/other', repos), {suites: []});
    assert.throws(() => currentTopics('{"go-race":true}'), /JSON list/);
    fs.writeFileSync(file, JSON.stringify({repos: {'not a name': {suites: []}}}));
    assert.throws(() => fleet(file), /owner\/repo/);
  } finally {
    if (saved === undefined) delete process.env.CI_TOPICS; else process.env.CI_TOPICS = saved;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('Fleet owns ci- and setting topics, and leaves any other topic as it is', () => {
  assert.deepEqual(topicsFor(['game', 'ci-old', 'go-race', 'rust-audit'], ['go'], ['go-race', 'home-sync']), ['ci-go', 'game', 'go-race', 'home-sync']);
  assert.deepEqual(topicsFor(['game', 'ci-go', 'go-race'], []), ['game']);
});

test('the real fleet list is valid', () => {
  assert.ok(Object.keys(fleet()).length > 0);
});

test('GreenMail users and Rust glibc floors are checked where they are declared', () => {
  const image = `artifacts.home.romaine.life/dockerhub/greenmail/standalone:2.1.3@sha256:${'a'.repeat(64)}`;
  const rust = (targets, values = []) => ({suites: ['release'], topics: ['release-rust', ...targets.map(t => `rust-build-${t}`)], release: values.length ? {rustTargets: values} : {}});
  for (const bad of [{suites: ['rust'], greenmail: {users: ['alice:secret@example.com']}},
    {suites: ['rust'], topics: ['service-greenmail'], service: {greenmail: image}, greenmail: {users: ['alice']}},
    {suites: ['rust'], topics: ['service-greenmail'], service: {greenmail: image}, greenmail: {users: []}},
    rust(['linux-arm64']), rust(['windows-amd64'], [{target: 'x86_64-pc-windows-msvc', glibc: '2.35'}]),
    rust(['linux-amd64'], [{target: 'x86_64-unknown-linux-gnu', glibc: 'latest'}]), rust(['linux-amd64'], [{target: 'x86_64-unknown-linux-gnu', strip: true}]),
    rust(['linux-amd64'], [{target: 'x86_64-unknown-linux-gnu', package: ''}]), rust(['linux-amd64'], [{target: 'x86_64-unknown-linux-gnu', package: 'a b'}])]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
  validate({suites: ['rust'], topics: ['service-greenmail'], service: {greenmail: image}, greenmail: {users: ['alice:secret@example.com', 'bob:secret@example.com']}});
  validate(rust(['linux-arm64', 'linux-amd64', 'windows-arm64'], [{target: 'aarch64-unknown-linux-gnu', glibc: '2.35'}]));
  validate(rust(['linux-amd64', 'windows-amd64'], [{target: 'x86_64-unknown-linux-gnu', package: 'spotify_player_session'}, {target: 'x86_64-pc-windows-msvc', package: 'spotify_player'}]));
});
