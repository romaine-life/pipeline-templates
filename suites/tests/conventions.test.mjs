import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nodeVersion, pythonProjects, pythonVersion, releaseManifest, tofuBackend} from '../conventions.mjs';

const repo = files => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conventions-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
};

test('Node and Python versions come from the repository, else the defaults', () => {
  assert.equal(nodeVersion(repo({})), '24');
  assert.equal(nodeVersion(repo({'.nvmrc': '20\n'})), '20');
  assert.equal(nodeVersion(repo({'.node-version': 'v22.11.0\n'})), '22');
  assert.throws(() => nodeVersion(repo({'.nvmrc': 'lts/*\n'})), /not a Node version/);
  assert.equal(pythonVersion(repo({})), '3.12');
  assert.equal(pythonVersion(repo({'.python-version': '3.13\n'})), '3.13');
  assert.throws(() => pythonVersion(repo({'.python-version': 'pypy3.10\n'})), /not a Python version/);
});

test('the Python projects are the root, else each directory with a pyproject.toml', () => {
  assert.deepEqual(pythonProjects([]), ['.']);
  assert.deepEqual(pythonProjects(['pyproject.toml', 'tools/pyproject.toml']), ['.']);
  assert.deepEqual(pythonProjects(['mcp/pyproject.toml', 'README.md']), ['mcp']);
});

test('the OpenTofu state is named after the repository', () => {
  assert.equal(tofuBackend('romaine-life/kill-me').key, 'kill-me.tfstate');
  assert.equal(tofuBackend('romaine-life/kill-me').storage_account_name, 'nelsontofu');
});

test('a manifest release numbers on the root manifest, or a workspace\'s one default member', () => {
  assert.equal(releaseManifest(repo({'Cargo.toml': '[package]\nname = "t"\nversion = "0.2.5"\n'})), 'Cargo.toml');
  assert.equal(releaseManifest(repo({'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\ndefault-members = ["a"]\n', 'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.25.1"\n'})), 'a/Cargo.toml');
  assert.throws(() => releaseManifest(repo({'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n'})), /no one default member/);
  assert.equal(releaseManifest(repo({'CMakeLists.txt': 'project(t VERSION 3.5)\n'})), 'CMakeLists.txt');
  assert.throws(() => releaseManifest(repo({})), /no Cargo.toml/);
});
