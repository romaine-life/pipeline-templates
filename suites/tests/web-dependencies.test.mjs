import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validate} from '../config.mjs';
import {hash} from '../lib.mjs';
import {readLock, writeLock, sourceURL, stage, newest, lockFile} from '../web-app/dependencies.mjs';

const wasm = {repository: 'romaine-life/fzt-browser', asset: 'fzt.wasm', destination: 'frontend/fzh/fzt.wasm'};
const model = {repository: 'romaine-life/string-box', path: 'renders/string-box.glb', destination: 'string-box/public/string-box.glb'};
const web = {image: 'x.azurecr.io/site', dependencies: [wasm, model]};

test('the lock reads and writes as sorted <destination> <tag> <sha256> lines', () => {
  const sha = 'a'.repeat(64);
  const entries = new Map([['z/b', {tag: 'v0.1.2', sha256: sha}], ['a/c', {tag: 'v1.0.3', sha256: sha}]]);
  const text = writeLock(entries);
  assert.equal(text, `a/c v1.0.3 ${sha}\nz/b v0.1.2 ${sha}\n`);
  assert.deepEqual([...readLock(text)], [...entries].reverse());
  assert.throws(() => readLock(`a/c v1 ${sha}\na/c v2 ${sha}`), /pinned twice/);
  assert.throws(() => readLock('a/c v1 notasha'), /expected/);
  assert.throws(() => readLock(`../x v1 ${sha}`), /repository-relative/);
});

test('a release asset and a path at the release tag have their Forgejo URLs', () => {
  assert.equal(sourceURL(wasm, 'v0.1.9', 'https://f.example'), 'https://f.example/romaine-life/fzt-browser/releases/download/v0.1.9/fzt.wasm');
  assert.equal(sourceURL(model, 'v0.1.4', 'https://f.example'), 'https://f.example/api/v1/repos/romaine-life/string-box/raw/renders/string-box.glb?ref=v0.1.4');
});

function inRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-deps-'));
  const cwd = process.cwd();
  process.chdir(root);
  return fn(root).finally(() => { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); });
}

test('staging writes exactly the pinned bytes and refuses anything else', () => inRepo(async root => {
  const bytes = {[sourceURL(wasm, 'v0.1.9')]: Buffer.from('wasm'), [sourceURL(model, 'v0.1.4')]: Buffer.from('glb')};
  const get = async url => bytes[url];
  const cache = () => { const dir = path.join(root, 'cache'); fs.mkdirSync(dir, {recursive: true}); return dir; };
  fs.writeFileSync(lockFile, writeLock(new Map([[wasm.destination, {tag: 'v0.1.9', sha256: hash('wasm')}], [model.destination, {tag: 'v0.1.4', sha256: hash('glb')}]])));
  await stage(web.dependencies, {get, token: 't', cache});
  assert.equal(fs.readFileSync(wasm.destination, 'utf8'), 'wasm');
  assert.equal(fs.readFileSync(model.destination, 'utf8'), 'glb');
  fs.writeFileSync(lockFile, writeLock(new Map([[wasm.destination, {tag: 'v0.1.9', sha256: hash('other')}], [model.destination, {tag: 'v0.1.4', sha256: hash('glb')}]])));
  await assert.rejects(stage(web.dependencies, {get, token: 't', cache}), /doesn't match its pinned checksum/);
  fs.writeFileSync(lockFile, writeLock(new Map([[model.destination, {tag: 'v0.1.4', sha256: hash('glb')}]])));
  await assert.rejects(stage(web.dependencies, {get, token: 't', cache}), /isn't pinned/);
  await assert.rejects(stage([wasm], {get, token: 't', cache}), /doesn't declare/);
}));

test("the newest lock takes each source's latest release once", async () => {
  const asked = [];
  const latest = async repository => { asked.push(repository); return {tag_name: repository.endsWith('browser') ? 'v0.1.10' : 'v0.1.5'}; };
  const get = async url => Buffer.from(url);
  const second = {...wasm, asset: 'fzt-web.js', destination: 'frontend/fzh/fzt-web.js'};
  const entries = await newest([wasm, second, model], {get, latest, token: 't'});
  assert.deepEqual(asked, ['romaine-life/fzt-browser', 'romaine-life/string-box']);
  assert.equal(entries.get(wasm.destination).tag, 'v0.1.10');
  assert.equal(entries.get(model.destination).sha256, hash(sourceURL(model, 'v0.1.5')));
});

test('web dependencies are validated', () => {
  validate({suites: ['web-app'], topics: ['web-image'], web}, 'test/site');
  for (const [bad, message] of [
    [{...wasm, path: 'x'}, /not both/],
    [{...wasm, repository: 'someone/else'}, /owned repository/],
    [{...wasm, destination: '../out'}, /repository-relative/],
    [{...wasm, extra: 1}, /unknown web dependency field/],
  ]) assert.throws(() => validate({suites: ['web-app'], topics: ['web-image'], web: {...web, dependencies: [bad]}}, 'test/site'), message);
  assert.throws(() => validate({suites: ['web-app'], topics: ['web-image'], web: {...web, dependencies: [wasm, {...model, destination: wasm.destination}]}}, 'test/site'), /two web dependencies/);
  assert.throws(() => validate({suites: ['web-app'], web: {dependencies: [wasm]}}, 'test/site'), /inputs to the web image or a release build/);
  // A release build can embed them too (fzt-desktop's frontend), with no image.
  validate({suites: ['release', 'rust'], topics: ['release-rust'], web: {dependencies: [wasm]}}, 'test/desktop');
});
