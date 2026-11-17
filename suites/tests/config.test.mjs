import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config, fleet, validate} from '../config.mjs';

test('unknown settings and unsafe paths fail visibly', () => {
  for (const bad of [{}, {suites: ['nope']}, {suites: ['default']}, {suites: ['go', 'go']}, {suites: [], go: {command: 'whatever'}},
    {suites: [], inputs: {'go.test': ['../other']}}, {suites: [], go: {platforms: ['linux']}}, {suites: [], release: {toolchains: ['go'], prefix: 'v0.1', prefixFrom: 'Cargo.toml'}},
    ...[[], {}, {'release.tag': 'command'}, {'__proto__.tag': 'tag'}].map(pinFields => ({suites: [], cluster: {pinFile: 'k8s/values.yaml', pinFields}})),
    {suites: [], web: {pinFields: {'release.tag': 'tag'}}}]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validate({suites: ['go'], go: {platforms: ['windows-latest', 'ubuntu-latest']}, inputs: {'go.test': ['assets/**']}}).suites, ['go']);
  assert.equal(validate({suites: [], cluster: {pinFile: 'k8s/values.yaml', pinFields: {'release.tag': 'tag', 'release.commit': 'commit', 'release.version': 'version'}}}).cluster.pinFields['release.commit'], 'commit');
});

test('a repository reads its own entry from the fleet list, and one it leaves out has no suites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  const file = path.join(dir, 'fleet.json');
  try {
    fs.writeFileSync(file, JSON.stringify({repos: {'o/one': {suites: ['go'], go: {platforms: ['windows-latest']}}}}));
    const repos = fleet(file);
    assert.deepEqual(config('o/one', repos).go.platforms, ['windows-latest']);
    assert.deepEqual(config('o/other', repos), {suites: []});
    fs.writeFileSync(file, JSON.stringify({repos: {'not a name': {suites: []}}}));
    assert.throws(() => fleet(file), /owner\/repo/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the real fleet list is valid', () => {
  assert.ok(Object.keys(fleet()).length > 0);
});

test('GreenMail users and Rust glibc floors are checked where they are declared', () => {
  const image = `artifacts.home.romaine.life/dockerhub/greenmail/standalone:2.1.3@sha256:${'a'.repeat(64)}`;
  const rust = rustTargets => ({suites: ['release'], release: {toolchains: ['rust'], rustTargets}});
  for (const bad of [{suites: ['rust'], greenmail: {users: ['alice:secret@example.com']}},
    {suites: ['rust'], service: {greenmail: image}, greenmail: {users: ['alice']}},
    {suites: ['rust'], service: {greenmail: image}, greenmail: {users: []}},
    rust([{target: 'aarch64-unknown-linux-gnu'}]), rust([{target: 'x86_64-pc-windows-msvc', glibc: '2.35'}]),
    rust([{target: 'x86_64-unknown-linux-gnu', glibc: 'latest'}]), rust([{target: 'x86_64-unknown-linux-gnu', strip: true}])]) {
    assert.throws(() => validate(bad), JSON.stringify(bad));
  }
  validate({suites: ['rust'], service: {greenmail: image}, greenmail: {users: ['alice:secret@example.com', 'bob:secret@example.com']}});
  validate(rust([{target: 'aarch64-unknown-linux-gnu', glibc: '2.35'}, {target: 'x86_64-unknown-linux-gnu'}, {target: 'aarch64-pc-windows-msvc'}]));
});
