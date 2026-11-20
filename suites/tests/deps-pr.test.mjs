import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeDependencies} from '../deps-pr.mjs';

// One take-up run against an open take-up with the same go.mod: reused while it merges,
// replaced and closed once Forgejo says it conflicts with main (ROLAT-3).
async function propose(mergeable) {
  process.env.GITHUB_SERVER_URL = 'https://f';
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_RUN_ID = '20';
  process.env.DEFAULT_BRANCH = 'main';
  const calls = [];
  const open = {number: 5, head: {ref: 'deps/10', sha: 'abc'}, mergeable, html_url: 'https://f/o/r/pulls/5', body: ''};
  const call = async (url, {method = 'GET'} = {}) => {
    calls.push([method, url]);
    if (url.includes('/pulls?state=open')) return [open, {number: 6, head: {ref: 'feature', sha: 'def'}}];
    if (url.includes('/contents/go.mod')) return {content: Buffer.from('module x\n').toString('base64')};
    return {};
  };
  const send = async (url, body) => { calls.push(['POST', url, body]); return {number: 7, html_url: 'https://f/o/r/pulls/7'}; };
  const queued = [];
  const pr = await proposeDependencies({files: ['go.mod'], title: 't', message: 'm', summary: 's', token: 'k'},
    {call, send, exec: (...args) => calls.push(['exec', ...args]), queue: async n => queued.push(n),
      read: () => Buffer.from('module x\n'), exists: () => true});
  return {pr, calls, queued};
}

test('an open take-up with the same contents is queued again while it merges', async () => {
  const {pr, calls, queued} = await propose(true);
  assert.equal(pr.number, 5);
  assert.deepEqual(queued, [5]);
  assert.equal(calls.some(c => c[0] === 'exec'), false);
});

test('a take-up that conflicts with main is replaced, not queued again', async () => {
  const {pr, calls, queued} = await propose(false);
  assert.equal(pr.number, 7);
  assert.deepEqual(queued, [7]);
  assert.ok(calls.some(c => c[0] === 'exec' && c[2][0] === 'push' && c[2].includes('HEAD:refs/heads/deps/20')));
  assert.ok(calls.some(c => c[0] === 'PATCH' && c[1].endsWith('/pulls/5')));
  assert.ok(calls.some(c => c[0] === 'DELETE' && c[1].endsWith('/branches/deps%2F10')));
});
