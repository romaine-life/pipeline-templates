import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {audience, audiences, main} from '../forgejo-token.mjs';

test('read is one audience; write is the repository\'s own integration, else the suites\'', () => {
  assert.equal(audience('read', 'romaine-life/pipeline-templates'), audiences.read);
  assert.equal(audience('write', 'romaine-life/pipeline-templates'), audiences['romaine-life/pipeline-templates']);
  assert.equal(audience('write', 'nelsong6/forgejo'), audiences['nelsong6/forgejo']);
  assert.equal(audience('write', 'romaine-life/at-home-tools'), audiences.write);
  assert.throws(() => audience('admin', 'nelsong6/forgejo'), /read or write/);
});

test('the token is the step output, masked, for the chosen audience', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-token-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const output = path.join(dir, 'output');
  let asked;
  t.mock.method(globalThis, 'fetch', async url => { asked = new URL(url); return new Response(JSON.stringify({value: 'jwt'})); });
  const logged = [];
  t.mock.method(console, 'log', line => logged.push(line));
  await main('write', {ACTIONS_ID_TOKEN_REQUEST_URL: 'https://f.example/id?run=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    GITHUB_REPOSITORY: 'nelsong6/forgejo', GITHUB_OUTPUT: output});
  assert.equal(asked.searchParams.get('audience'), audiences['nelsong6/forgejo']);
  assert.deepEqual(logged, ['::add-mask::jwt']);
  assert.equal(fs.readFileSync(output, 'utf8'), 'token=jwt\n');
  await assert.rejects(main('read', {GITHUB_OUTPUT: output}), /enable-openid-connect/);
});
