import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {vcpkgArguments, vcpkgEnvironment} from '../cmake/vcpkg.mjs';
import {through} from '../cmake/vcpkg-fetch.mjs';

test('vcpkg reads its registry from Forgejo, downloads through Artifact Keeper, and signs in only with a token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpkg-root-'));
  fs.mkdirSync(path.join(root, 'scripts/buildsystems'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts/buildsystems/vcpkg.cmake'), '');
  const options = {root, server: 'https://forgejo.romaine.life/', cache: () => 'kept'};
  const env = vcpkgEnvironment({...options, token: 't0k'});
  assert.equal(env.VCPKG_DEFAULT_BINARY_CACHE, 'kept');
  assert.equal(env.VCPKG_MAX_CONCURRENCY, '4');
  assert.match(env.X_VCPKG_ASSET_SOURCES, /^clear;x-script,".+" ".+vcpkg-fetch\.mjs" "\{url\}" "\{dst\}";x-block-origin$/);
  assert.equal(env.GIT_CONFIG_KEY_0, 'url.https://forgejo.romaine.life/microsoft/vcpkg.insteadOf');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'https://github.com/microsoft/vcpkg');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://forgejo.romaine.life/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_1, `Authorization: Basic ${Buffer.from('x-access-token:t0k').toString('base64')}`);
  const local = vcpkgEnvironment({...options, token: ''});
  assert.equal(local.GIT_CONFIG_COUNT, '1');
  assert.equal(local.GIT_CONFIG_KEY_1, undefined);
  assert.throws(() => vcpkgEnvironment({...options, root: path.join(root, 'missing')}), /VCPKG_ROOT names no vcpkg/);
  assert.deepEqual(vcpkgArguments('build', 'C:\\ci\\vcpkg-trees\\0a1b'), ['-DVCPKG_INSTALL_OPTIONS=--x-buildtrees-root=C:/ci/vcpkg-trees/0a1b']);
  fs.rmSync(root, {recursive: true, force: true});
});

test('vcpkg downloads map to Artifact Keeper caches, and an uncached host fails naming it', () => {
  assert.equal(through('https://github.com/libevent/libevent/archive/release-2.1.12-stable.tar.gz'),
    'https://artifacts.home.romaine.life/general/github/libevent/libevent/archive/release-2.1.12-stable.tar.gz');
  assert.equal(through('https://repo.msys2.org/msys/x86_64/bash.pkg.tar.zst'), 'https://artifacts.home.romaine.life/general/msys2/msys/x86_64/bash.pkg.tar.zst');
  assert.equal(through('https://www.python.org/ftp/python/3.12.0/python-3.12.0-embed-amd64.zip'), 'https://artifacts.home.romaine.life/general/python-downloads/3.12.0/python-3.12.0-embed-amd64.zip');
  assert.throws(() => through('https://example.com/a.zip'), /no Artifact Keeper cache serves its host/);
});
