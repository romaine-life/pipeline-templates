'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {releaseVersion, prefixFrom} = require('../version.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// A fake Forgejo holding tags, served 50 to a page; POST /tags creates one, 409 when taken.
// `race` names a tag another run creates just before this run's first POST.
function forgejo(tags, {race} = {}) {
  const created = [];
  const fetch = async (url, {method, headers, body}) => {
    assert.equal(headers.Authorization, 'token t');
    const {pathname, searchParams} = new URL(url);
    assert.equal(pathname.startsWith('/api/v1/repos/o/r/tags'), true);
    if (method === 'GET') {
      const page = Number(searchParams.get('page'));
      const slice = tags.slice((page - 1) * 50, page * 50);
      return {ok: true, headers: new Map([['x-total-count', String(tags.length)]]), json: async () => slice};
    }
    const {tag_name, target} = JSON.parse(body);
    if (race) { tags.push({name: race, commit: {sha: B}}); race = undefined; }
    if (tags.some(t => t.name === tag_name)) return {ok: false, status: 409};
    tags.push({name: tag_name, commit: {sha: target}});
    created.push(tag_name);
    return {ok: true, status: 201};
  };
  return {fetch, created};
}
const tag = (name, sha = B) => ({name, commit: {sha}});
const run = (f, opts) => releaseVersion({api: 'https://f/api/v1/repos/o/r', token: 't', log: () => {}, fetch: f.fetch, run: 871, ...opts});

test('a release takes the next number in its series, ignoring other series and hashes', async () => {
  const f = forgejo([tag('v0.1.9'), tag('v0.1.10'), tag('v0.2.40'), tag('v0.1.11-3-gabcdef1'), tag('coach-v0.1.50')]);
  const result = await run(f, {series: 'v0.1', publish: true, sha: A});
  assert.deepEqual(result, {version: 'v0.1.11', tag: 'v0.1.11', reserved: true});
  assert.deepEqual(f.created, ['v0.1.11']);
});

test('a series with no tags starts at 0', async () => {
  const f = forgejo([tag('v0.25.1-131-g3febcd6'), tag('v0.25.1')]);
  assert.equal((await run(f, {series: 'v0.25.1', publish: true, sha: A})).version, 'v0.25.1.0');
});

test('a commit already numbered keeps its number and creates nothing', async () => {
  const f = forgejo([tag('v0.1.4', A), tag('v0.1.5')]);
  assert.deepEqual(await run(f, {series: 'v0.1', publish: true, sha: A}), {version: 'v0.1.4', tag: 'v0.1.4', reserved: false});
  assert.deepEqual(f.created, []);
});

test('a number another run takes first is skipped', async () => {
  const f = forgejo([tag('v0.1.4')], {race: 'v0.1.5'});
  assert.equal((await run(f, {series: 'v0.1', publish: true, sha: A})).version, 'v0.1.6');
});

test('the series is read across pages', async () => {
  const f = forgejo(Array.from({length: 120}, (_, i) => tag(`v1.0.${i}`)));
  assert.equal((await run(f, {series: 'v1.0', publish: true, sha: A})).version, 'v1.0.120');
});

test('a component numbers its own series', async () => {
  const f = forgejo([tag('v0.1.7'), tag('coach-v0.1.2')]);
  assert.equal((await run(f, {series: 'coach-v0.1', publish: true, sha: A})).version, 'coach-v0.1.3');
});

test('a PR build is named after the next number, the PR and the run, and tags nothing', async () => {
  const f = forgejo([tag('v0.1.133')]);
  assert.deepEqual(await run(f, {series: 'v0.1', publish: false, pullRequest: '152'}), {version: 'v0.1.134-pr152.871', tag: '', reserved: false});
  assert.deepEqual(f.created, []);
});

test('a build from no PR is named after the run', async () => {
  assert.equal((await run(forgejo([]), {series: 'v0.1', publish: false, pullRequest: ''})).version, 'v0.1.0-run871');
});

test('no version ever carries a commit hash', async () => {
  for (const publish of [true, false]) {
    const {version} = await run(forgejo([tag('v0.1.1')]), {series: 'v0.1', publish, sha: A, pullRequest: '3'});
    assert.doesNotMatch(version, /[0-9a-f]{7,}/);
  }
});

test('a release needs a full commit and refuses a refused tag', async () => {
  await assert.rejects(run(forgejo([]), {series: 'v0.1', publish: true, sha: 'abc1234'}), /not a commit/);
  const denied = {fetch: async (url, {method}) => method === 'GET'
    ? {ok: true, headers: new Map([['x-total-count', '0']]), json: async () => []}
    : {ok: false, status: 403}};
  await assert.rejects(run(denied, {series: 'v0.1', publish: true, sha: A}), /HTTP 403/);
});

test('the series is read from the version a file declares', () => {
  assert.equal(prefixFrom('x/Cargo.toml', '[package]\nname = "spt"\nauthors = ["a"]\nversion = "0.25.1"\n\n[dependencies]\nversion = "9"\n'), 'v0.25.1');
  assert.equal(prefixFrom('Cargo.toml', '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.2.0"\n'), 'v1.2.0');
  assert.equal(prefixFrom('CMakeLists.txt', 'set(PACKAGE_VERSION "3.6a-win32")\n'), 'v3.6a');
  assert.equal(prefixFrom('CMakeLists.txt', 'project(tmux VERSION 3.5 LANGUAGES C)\n'), 'v3.5');
  assert.equal(prefixFrom('package.json', '{"version": "2.0.1-beta.3"}'), 'v2.0.1');
  assert.throws(() => prefixFrom('Cargo.toml', '[dependencies]\nversion = "1"\n'), /declares no version/);
  assert.throws(() => prefixFrom('setup.py', ''), /not a Cargo.toml/);
});

test('a suffix keeps fixed parts after the count', async () => {
  const f = forgejo([tag('v1.25.24.0'), tag('v1.25.3.0'), tag('v1.25.9')]);
  assert.equal((await run(f, {series: 'v1.25', suffix: '.0', publish: true, sha: A})).version, 'v1.25.25.0');
  assert.equal((await run(forgejo([tag('v1.25.24.0')]), {series: 'v1.25', suffix: '.0', publish: false, pullRequest: '7'})).version, 'v1.25.25.0-pr7.871');
});
