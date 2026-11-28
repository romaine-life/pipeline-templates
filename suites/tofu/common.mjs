import fs from 'node:fs';
import path from 'node:path';
import {kept, run} from '../lib.mjs';
import {currentRepository} from '../config.mjs';
import {tofuBackend} from '../conventions.mjs';
import {lockFile, sources} from './providers.mjs';
export function tofu(args) { run('tofu', ['-chdir=tofu', ...args]); }
// A provider's address as a lock names it: a source with no host is OpenTofu's registry's.
export const address = source => (source.split('/').length === 2 ? `registry.opentofu.org/${source}` : source).toLowerCase();

// The shared lock cut to the providers a configuration names: `tofu init -lockfile=readonly`
// refuses a lock holding a provider the configuration doesn't use.
export function lockFor(lock, used) {
  const wanted = new Set([...used].map(address));
  return lock.replace(/^provider "([^"]+)" \{\r?\n[\s\S]*?^\}\r?\n(\r?\n)?/gm, (block, name) => wanted.has(name.toLowerCase()) ? block : '');
}

// Every `source = "..."` in a directory's .tf files, its modules' included; a module's own
// source never names a provider, so it matches nothing in the lock.
export function configuredSources(dir) {
  const found = new Set();
  for (const entry of fs.readdirSync(dir, {withFileTypes: true, recursive: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.tf')) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (file.split(path.sep).includes('.terraform')) continue;
    for (const source of sources(fs.readFileSync(file, 'utf8'))) found.add(source);
  }
  return found;
}

// Every repository runs with the shared provider set's lock (providers/providers.tf), which
// only CI writes (IB-3), cut to the providers it uses. A repository's own lock is refused:
// one written by hand could hold what the set doesn't (PIPT-59).
export function useSharedLock({from = lockFile, dir = 'tofu'} = {}) {
  const to = path.join(dir, '.terraform.lock.hcl');
  fs.mkdirSync(dir, {recursive: true});
  const lock = lockFor(fs.readFileSync(from, 'utf8'), configuredSources(dir));
  // The suite's own earlier step in this checkout (a plan before an apply) leaves this same lock.
  if (fs.existsSync(to) && fs.readFileSync(to, 'utf8') !== lock) throw new Error(`${to.replaceAll(path.sep, '/')} is this repository's own lock: the tofu suite gives every repository the shared provider set's (pipeline-templates suites/tofu/providers), so delete it and the version pins in required_providers`);
  fs.writeFileSync(to, lock);
}
export function init() {
  process.env.TF_PLUGIN_CACHE_DIR = kept(`tofu-providers/${(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-')}`);
  if (useSharedLock()) console.log('Using the shared provider set\'s lock.');
  const backend = tofuBackend(currentRepository());
  tofu(['init', '-input=false', '-lockfile=readonly', ...Object.entries(backend).map(([k, v]) => `-backend-config=${k}=${v}`)]);
}
