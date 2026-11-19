import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config, fleet, validate} from '../config.mjs';
import {currentTopics, resolve, settingTopics, validTopic} from '../topics.mjs';
import {checkVariants} from '../fingerprints.mjs';
import {rustTargets} from '../layout.mjs';
import {topicsFor} from '../fleet.mjs';

test('unknown settings and unsafe paths fail visibly', () => {
  for (const bad of [{}, {suites: ['nope']}, {suites: ['default']}, {suites: ['go', 'go']}, {suites: [], go: {command: 'whatever'}},
    {suites: [], inputs: {'go.test': ['assets/**']}}, {suites: [], go: {platforms: ['windows-latest']}}, {suites: [], release: {homeSync: true}},
    {suites: ['release'], release: {prefix: 'v0.1'}}, {suites: ['tofu'], tofu: {version: '1.9.0'}}, {suites: ['docs'], docs: {required: ['INDEX.md']}}, {suites: ['web-app'], web: {node: '22'}},
    {suites: ['cluster-service'], cluster: {image: 'forgejo.romaine.life/o/app'}}, {suites: ['web-app'], web: {pinFile: 'k8s/values.yaml'}},
    {suites: ['web-app'], topics: ['web-static', 'web-image']}]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validate({suites: ['go'], topics: ['go-test-windows', 'go-test-linux']}).suites, ['go']);
});

test('setting topics are Forgejo topics, never a suite, and the list holds only them', () => {
  for (const topic of settingTopics) assert.ok(validTopic(topic) && !topic.startsWith('ci-'), topic);
  for (const topics of [['ci-go'], ['game'], ['go-race', 'go-race'], 'go-race']) assert.throws(() => validate({suites: ['go'], topics}), JSON.stringify(topics));
  assert.throws(() => validate({suites: ['go'], topics: settingTopics.slice(0, 25)}), /25 topics/);
});

test('a selected value is in the list exactly when its topic is', () => {
  const image = `artifacts.home.romaine.life/dockerhub/library/postgres:17@sha256:${'a'.repeat(64)}`;
  validate({suites: ['go'], topics: ['service-postgres']});
  for (const bad of [{suites: ['go'], topics: ['service-postgres'], service: {postgres: image}},
    {suites: ['release'], topics: ['release-rust', 'rust-build-linux-amd64'], release: {rustTargets: [{target: 'x86_64-unknown-linux-gnu'}]}}]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
});

test('topics select the settings the suites read', () => {
  const cfg = resolve({suites: ['cluster-service', 'go', 'release', 'rust', 'powershell']},
    ['go-test-windows', 'rust-test-linux', 'rust-test-windows', 'go-race', 'rust-audit', 'rust-typos', 'windows-powershell', 'release-rust', 'release-go', 'home-sync',
      'version-four-part', 'rust-build-linux-amd64', 'rust-build-windows-amd64', 'game', 'ci-go']);
  assert.deepEqual(cfg.go, {platforms: ['windows-latest'], race: ['./...']});
  assert.deepEqual(cfg.rust, {platforms: ['ubuntu-latest', 'windows-latest'], lints: ['typos', 'audit']});
  assert.deepEqual(cfg.release, {toolchains: ['go', 'rust'], homeSync: true, suffix: '.0',
    rustTargets: [{target: 'x86_64-pc-windows-msvc'}, {target: 'x86_64-unknown-linux-gnu'}]});
  assert.deepEqual(cfg.powershell, {windowsPowerShell: true});
  // Without cluster-image a cluster service builds no image.
  assert.deepEqual(cfg.cluster, {build: false, smoke: false});
  assert.ok(!cfg.topics.includes('game') && !cfg.topics.includes('ci-go'));
  // No topic: tests on Linux, no lints, no release builds.
  const bare = resolve({suites: ['go', 'rust', 'release']}, []);
  assert.deepEqual(bare, {suites: ['go', 'rust', 'release'], topics: []});
  assert.deepEqual(checkVariants('rust', bare).map(c => c.key), ['rust.format/ubuntu-latest', 'rust.test/ubuntu-latest']);
  // An image, its registry sign-in and a Static Web App are named for the repository.
  const named = resolve({suites: ['cluster-service', 'web-app']}, ['cluster-image', 'web-image'], 'o/app');
  assert.deepEqual(named.cluster, {image: 'forgejo.romaine.life/o/app', baoRole: 'app-publish', baoSecret: 'services/app-build'});
  assert.deepEqual(named.web, {image: 'romainecr.azurecr.io/app'});
  assert.deepEqual(resolve({suites: ['web-app']}, ['web-static'], 'o/site').web, {staticApp: 'site-app', resourceGroup: 'site-rg'});
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

// A repository's services are its own ci/services.json, named exactly as its topics select them.
test("the tests' services come from the repository's ci/services.json", () => {
  const image = name => `artifacts.home.romaine.life/dockerhub/${name}:1@sha256:${'a'.repeat(64)}`;
  const run = (files, topics) => config('o/app', {'o/app': {suites: ['go']}}, topics, {files: Object.keys(files), read: file => files[file] ?? null});
  assert.equal(run({}, []).service, undefined);
  const mail = {image: image('greenmail'), users: ['alice:secret@example.com', 'bob:secret@example.com']};
  const cfg = run({'ci/services.json': JSON.stringify({postgres: {image: image('postgres')}, greenmail: mail})}, ['service-postgres', 'service-greenmail']);
  assert.deepEqual(cfg.service, {postgres: image('postgres'), greenmail: image('greenmail')});
  assert.deepEqual(cfg.greenmail, {users: mail.users});
  for (const [services, topics] of [[undefined, ['service-postgres']], [{postgres: {image: image('postgres')}}, []],
    [{postgres: {image: image('postgres')}}, ['service-postgres', 'service-manticore']], [{redis: {image: image('redis')}}, []],
    [{postgres: {image: 'postgres:17'}}, ['service-postgres']], [{postgres: image('postgres')}, ['service-postgres']],
    [{postgres: {image: image('postgres'), users: mail.users}}, ['service-postgres']],
    [{greenmail: {...mail, users: ['alice']}}, ['service-greenmail']], [{greenmail: {...mail, users: []}}, ['service-greenmail']], [[], []]]) {
    assert.throws(() => run(services === undefined ? {} : {'ci/services.json': JSON.stringify(services)}, topics), JSON.stringify([services, topics]));
  }
  // The list holds no service settings any more.
  assert.throws(() => validate({suites: ['go'], topics: ['service-postgres'], service: {postgres: image('postgres')}}), /unknown field service/);
});

test("a Rust release target's values are the repository's Cargo.toml's", () => {
  const targets = (...names) => names.map(target => ({target}));
  const linux = 'x86_64-unknown-linux-gnu', arm = 'aarch64-unknown-linux-gnu', windows = 'x86_64-pc-windows-msvc';
  const workspace = values => `[workspace]
members = ["a"]
${Object.entries(values).map(([target, body]) => `[workspace.metadata.pipeline-templates.targets.${target}]
${body}
`).join('')}`;
  assert.deepEqual(rustTargets(targets(linux, windows), null), targets(linux, windows));
  assert.deepEqual(rustTargets(targets(linux, windows), workspace({[linux]: 'package = "spotify_player_session"', [windows]: 'package = "spotify_player"'})),
    [{target: linux, package: 'spotify_player_session'}, {target: windows, package: 'spotify_player'}]);
  assert.deepEqual(rustTargets(targets(windows), workspace({[windows]: 'features = ["custom-protocol"]'})), [{target: windows, features: ['custom-protocol']}]);
  assert.deepEqual(rustTargets(targets(linux, arm), `[package]
name = "a"
[package.metadata.pipeline-templates.targets.${arm}]
glibc = "2.35"
`),
    [{target: linux}, {target: arm, glibc: '2.35'}]);
  for (const [list, text] of [[targets(arm), null], [targets(linux), workspace({[windows]: 'package = "a"'})],
    [targets(windows), workspace({[windows]: 'glibc = "2.35"'})], [targets(linux), workspace({[linux]: 'glibc = "latest"'})],
    [targets(linux), workspace({[linux]: 'strip = true'})], [targets(linux), workspace({[linux]: 'package = ""'})],
    [targets(linux), workspace({[linux]: 'package = "a b"'})], [targets(linux), workspace({[linux]: 'features = "a"'})]]) {
    assert.throws(() => rustTargets(list, text), text || 'no Cargo.toml');
  }
});
