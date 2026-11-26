import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dir, generate, mirrors, sources} from '../tofu/providers.mjs';
import {address, lockFor, useSharedLock} from '../tofu/common.mjs';

test('the shared set pins every provider to one exact version', () => {
  const text = fs.readFileSync(path.join(dir, 'providers.tf'), 'utf8');
  const blocks = [...text.matchAll(/source\s*=\s*"([^"]+)"\s*\n\s*version\s*=\s*"([^"]+)"/g)];
  assert.equal(blocks.length, sources(text).length, 'each source is followed by its version');
  for (const [, source, version] of blocks) assert.match(version, /^\d+\.\d+\.\d+$/, `${source} is pinned exactly`);
});

test('the lock is made through the mirror that holds each provider, for linux_amd64', () => {
  const calls = [];
  const lock = generate({exec(command, args) {
    calls.push([command, args]);
    const work = args[0].slice('-chdir='.length);
    fs.appendFileSync(path.join(work, '.terraform.lock.hcl'), `# ${args.slice(4).join(' ')}\n`);
  }});
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([command, args]) => command === 'tofu' && args[1] === 'providers' && args[2] === 'lock' && args[4] === '-platform=linux_amd64'));
  assert.equal(calls[0][1][3], `-net-mirror=${mirrors[0].url}`);
  assert.ok(calls[0][1].includes('hashicorp/azurerm') && !calls[0][1].some(a => a.startsWith('artifacts.home.romaine.life/')));
  assert.equal(calls[1][1][3], `-net-mirror=${mirrors[1].url}`);
  assert.deepEqual(calls[1][1].slice(5), ['artifacts.home.romaine.life/romaine-life/forgejo', 'artifacts.home.romaine.life/romaine-life/openproject']);
  assert.match(lock, /hashicorp\/azurerm[\s\S]*romaine-life\/forgejo/);
});

test('a repository is given the shared lock, cut to its own providers, unless its checkout has its own', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-lock-'));
  try {
    const from = path.join(root, 'shared.hcl');
    fs.writeFileSync(from, [
      '# This file is maintained automatically by "tofu init".', '',
      'provider "artifacts.home.romaine.life/romaine-life/forgejo" {', '  version = "1.7.1"', '}', '',
      'provider "registry.opentofu.org/hashicorp/azurerm" {', '  version = "4.71.0"', '}', '',
      'provider "registry.opentofu.org/hashicorp/random" {', '  version = "3.9.0"', '}', ''].join('\n'));
    const own = path.join(root, 'own');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, '.terraform.lock.hcl'), 'own');
    assert.equal(useSharedLock({from, dir: own}), false);
    assert.equal(fs.readFileSync(path.join(own, '.terraform.lock.hcl'), 'utf8'), 'own');

    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'store'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'main.tf'), [
      'terraform {', '  required_providers {', '    azurerm = {', '      source = "hashicorp/azurerm"', '    }', '  }', '}',
      'module "store" {', '  source = "./store"', '}', ''].join('\n'));
    fs.writeFileSync(path.join(repo, 'store', 'versions.tf'), [
      'terraform {', '  required_providers {', '    forgejo = { source = "artifacts.home.romaine.life/romaine-life/forgejo" }', '  }', '}', ''].join('\n'));
    assert.equal(useSharedLock({from, dir: repo}), true);
    const lock = fs.readFileSync(path.join(repo, '.terraform.lock.hcl'), 'utf8');
    assert.match(lock, /hashicorp\/azurerm/);
    assert.match(lock, /romaine-life\/forgejo/);
    assert.doesNotMatch(lock, /hashicorp\/random/);
    assert.equal(lockFor(lock, []).trim(), '# This file is maintained automatically by "tofu init".');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("a source with no host is OpenTofu's registry's", () => {
  assert.equal(address('hashicorp/azurerm'), 'registry.opentofu.org/hashicorp/azurerm');
  assert.equal(address('artifacts.home.romaine.life/romaine-life/forgejo'), 'artifacts.home.romaine.life/romaine-life/forgejo');
});
