// Settings fleet.json no longer holds (PIPT-33): what every repository shares, and what a
// repository's own files already say, read the way their tools read them.
import fs from 'node:fs';
import path from 'node:path';
import TOML from '@iarna/toml';
import {tracked} from './lib.mjs';

export const tofuVersion = '1.11.0';
export const requiredDocs = ['README.md'];

// Every repository's OpenTofu state is <repo>.tfstate in the one state container.
export const tofuBackend = repo => ({
  resource_group_name: 'infra', storage_account_name: 'nelsontofu', container_name: 'tfstate',
  key: `${repo.split('/').pop()}.tfstate`,
});

const firstLine = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim() : '';

// Node's major version: the repository's .nvmrc, else its .node-version, as nvm and
// actions/setup-node read them; else 24. actions/pins.txt pins the exact release per major.
export function nodeVersion(dir = '.') {
  for (const name of ['.nvmrc', '.node-version']) {
    const value = firstLine(path.join(dir, name));
    if (!value) continue;
    const major = value.match(/^v?(\d+)(?:\.\d+){0,2}$/)?.[1];
    if (!major) throw new Error(`${name}: ${value} is not a Node version such as 22`);
    return major;
  }
  return '24';
}

// Python's version: the repository's .python-version, as uv reads it; else 3.12.
export function pythonVersion(dir = '.') {
  const value = firstLine(path.join(dir, '.python-version'));
  if (!value) return '3.12';
  if (!/^3\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`.python-version: ${value} is not a Python version such as 3.13`);
  return value;
}

// The Python projects: the root's pyproject.toml, else each directory holding one.
export function pythonProjects(files = tracked()) {
  const dirs = files.filter(file => path.posix.basename(file) === 'pyproject.toml').map(file => path.posix.dirname(file));
  return dirs.includes('.') || !dirs.length ? ['.'] : [...new Set(dirs)].sort();
}

// The manifest a version-from-manifest release numbers on: the root Cargo.toml's package or
// workspace version, or the one default member's of a workspace that has none; else the root
// CMakeLists.txt; else the root package.json.
export function releaseManifest(dir = '.') {
  const read = file => fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : undefined;
  const cargo = read('Cargo.toml');
  if (cargo !== undefined) {
    const value = TOML.parse(cargo);
    if (value.package?.version || value.workspace?.package?.version) return 'Cargo.toml';
    const members = value.workspace?.['default-members'] || [];
    if (members.length === 1 && TOML.parse(read(`${members[0]}/Cargo.toml`) || '').package?.version) return `${members[0]}/Cargo.toml`;
    throw new Error('version-from-manifest: Cargo.toml declares no version, and the workspace has no one default member that does');
  }
  if (read('CMakeLists.txt') !== undefined) return 'CMakeLists.txt';
  if (read('package.json') !== undefined) return 'package.json';
  throw new Error('version-from-manifest: no Cargo.toml, CMakeLists.txt or package.json at the root');
}
