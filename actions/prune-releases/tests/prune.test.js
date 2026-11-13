'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {prune, KEEP} = require('../prune.js');

// A fake Forgejo: releases served 50 to a page, newest first, recording each DELETE.
function forgejo(releases, {denyDelete = false} = {}) {
  const deleted = [];
  const fetch = async (url, {method, headers}) => {
    assert.equal(headers.Authorization, 'token t');
    const {pathname, searchParams} = new URL(url);
    if (method === 'GET') {
      assert.equal(searchParams.get('draft'), 'false');
      const page = Number(searchParams.get('page'));
      const sorted = [...releases].sort((a, b) => b.id - a.id);
      const body = sorted.slice((page - 1) * 50, page * 50);
      return {ok: true, headers: new Map([['x-total-count', String(releases.length)]]), json: async () => body};
    }
    if (denyDelete) return {ok: false, status: 403};
    deleted.push(pathname.replace('/api/v1/repos/o/r', ''));
    return {ok: true};
  };
  return {fetch, deleted};
}
const release = (id, extra = {}) => ({id, draft: false, prerelease: false, assets: [{id: id * 10, size: 1000}, {id: id * 10 + 1, size: 500}], ...extra});
const run = f => prune({api: 'https://f/api/v1/repos/o/r', token: 't', fetch: f.fetch, log: () => {}});

test('keeps the newest releases and deletes every older file, across pages', async () => {
  const f = forgejo(Array.from({length: 120}, (_, i) => release(i + 1)));
  const result = await run(f);
  assert.equal(result.files, (120 - KEEP) * 2);
  assert.equal(result.bytes, (120 - KEEP) * 1500);
  assert.ok(f.deleted.includes('/releases/1/assets/10'));
  assert.ok(f.deleted.includes(`/releases/${120 - KEEP}/assets/${(120 - KEEP) * 10 + 1}`));
  assert.ok(!f.deleted.includes(`/releases/${120 - KEEP + 1}/assets/${(120 - KEEP + 1) * 10}`));
});

test('keeps the newest stable release when newer ones are prereleases', async () => {
  const f = forgejo(Array.from({length: 15}, (_, i) => release(i + 1, {prerelease: i + 1 > 3})));
  await run(f);
  assert.ok(!f.deleted.some(p => p.startsWith('/releases/3/')));
  assert.ok(f.deleted.includes('/releases/2/assets/20'));
});

test('leaves drafts alone and does nothing with few releases', async () => {
  const f = forgejo([...Array.from({length: KEEP}, (_, i) => release(i + 1)), release(99, {draft: true})]);
  assert.equal((await run(f)).files, 0);
  assert.deepEqual(f.deleted, []);
});

test('a refused delete fails the step', async () => {
  const f = forgejo(Array.from({length: KEEP + 1}, (_, i) => release(i + 1)), {denyDelete: true});
  await assert.rejects(run(f), /DELETE \/releases\/1\/assets\/10: HTTP 403/);
});

test('a missing token fails before any request', async () => {
  await assert.rejects(prune({api: 'x', token: '', fetch: () => assert.fail('no request')}), /missing release token/);
});
