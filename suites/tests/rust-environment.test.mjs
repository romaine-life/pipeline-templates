import test from 'node:test';
import assert from 'node:assert/strict';
import {rustEnvironment} from '../rust/environment.mjs';

test('a Forgejo git dependency is fetched through git with the token, and nothing else changes', () => {
  const forgejo = 'source = "git+https://forgejo.romaine.life/nelsong6/shows.git?rev=cf0141b#cf0141b"';
  const env = rustEnvironment('t0k', forgejo);
  assert.equal(env.CARGO_NET_GIT_FETCH_WITH_CLI, 'true');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://forgejo.romaine.life/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('x-access-token:t0k').toString('base64')}`);
  assert.deepEqual(rustEnvironment('t0k', 'source = "registry+https://github.com/rust-lang/crates.io-index"'), {});
  assert.throws(() => rustEnvironment('', forgejo), /PRIVATE_GIT_TOKEN/);
});
