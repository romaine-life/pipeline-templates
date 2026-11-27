import test from 'node:test';
import assert from 'node:assert/strict';
import {queuePR} from '../queue.mjs';

test('a bot PR is handed to merge-queue by its queue label, made when the repo has none', async () => {
  for (const existing of [[{id: 3, name: 'queue'}], [{id: 1, name: 'bug'}]]) {
    const calls = [];
    const get = async url => { calls.push(['GET', url]); return existing; };
    const send = async (url, body) => { calls.push(['POST', url, body]); return url.endsWith('/labels') ? {id: 9, name: 'queue'} : {}; };
    await queuePR(7, {token: 't', url: 'https://f/api/v1/repos/o/r', get, send});
    const labelled = calls.find(c => c[1].endsWith('/issues/7/labels'));
    assert.deepEqual(labelled[2], {labels: [existing[0].name === 'queue' ? 3 : 9]});
    assert.equal(calls.some(c => c[0] === 'POST' && c[1].endsWith('/r/labels')), existing[0].name !== 'queue');
  }
  await assert.rejects(queuePR(7, {}), /forgejo-token/);
});
