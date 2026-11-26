import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../lib.mjs';
import {gitConfigFile, goEnvironment, goPrivate} from '../go/environment.mjs';

const goMod = 'module github.com/romaine-life/app\n\nrequire github.com/romaine-life/logline v0.1.4\n';
const header = `Authorization: Basic ${Buffer.from('x-access-token:t0k').toString('base64')}`;

test('our Go modules come from Forgejo through git, signed in when there is a token', () => {
  assert.equal(goPrivate('module github.com/romaine-life/app\n\nrequire golang.org/x/net v0.1.0\n', 't0k'), null, 'its own module path is no requirement');
  assert.deepEqual(goPrivate(goMod, '', 'https://forgejo.romaine.life/'), {env: {GOPRIVATE: 'github.com/romaine-life/*', GONOSUMDB: 'github.com/romaine-life/*'},
    git: [['url.https://forgejo.romaine.life/romaine-life/.insteadOf', 'https://github.com/romaine-life/']]});
  assert.deepEqual(goPrivate(goMod, 't0k', 'https://forgejo.romaine.life').git[1], ['http.https://forgejo.romaine.life/romaine-life/.extraheader', header]);
});

test('a Go step gets the settings as git config variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-environment-')), cwd = process.cwd(), old = {...process.env};
  try {
    process.chdir(dir);
    fs.writeFileSync('go.mod', goMod);
    Object.assign(process.env, {GITHUB_SERVER_URL: 'https://forgejo.romaine.life', PRIVATE_GO_TOKEN: 't0k'});
    goEnvironment();
    assert.equal(process.env.GOPRIVATE, 'github.com/romaine-life/*');
    assert.equal(process.env.GIT_CONFIG_COUNT, '2');
    assert.equal(process.env.GIT_CONFIG_KEY_0, 'url.https://forgejo.romaine.life/romaine-life/.insteadOf');
    assert.equal(process.env.GIT_CONFIG_VALUE_1, header);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test("an image build's git config file reads in git as the Go step's variables do", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-git-config-'));
  try {
    const file = path.join(dir, 'gitconfig');
    fs.writeFileSync(file, gitConfigFile(goPrivate(goMod, 't0k', 'https://forgejo.romaine.life').git));
    const read = key => capture('git', ['config', '--file', file, '--get', key]);
    assert.equal(read('url.https://forgejo.romaine.life/romaine-life/.insteadof'), 'https://github.com/romaine-life/');
    assert.equal(read('http.https://forgejo.romaine.life/romaine-life/.extraheader'), header);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
