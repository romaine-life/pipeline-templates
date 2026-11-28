// Go modules among our repositories (PIPT-34). A repository whose root go.mod names a module
// under github.com/romaine-life/ (served from Forgejo, the GOPRIVATE prefix go/dependencies.mjs
// sets) releases it with each release; each fleet repository with
// the go suite whose go.mod requires it then gets a take-up (go/dependencies.yml), which takes
// the newest version of every such module its go.mod requires. Nothing lists who uses what:
// go.mod says it.
import fs from 'node:fs';
import {post, request} from '../lib.mjs';
import {currentRepository, fleet} from '../config.mjs';

const server = () => process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life';
export const prefix = 'github.com/romaine-life/';

// go.mod's module path, and the module paths its require directives name, single-line and
// block form alike, indirect ones included.
export function parseGoMod(text) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '').trim());
  const module = lines.map(line => line.match(/^module\s+"?([^\s"]+)"?$/)).find(Boolean)?.[1] || null;
  const requires = [];
  let block = false;
  for (const line of lines) {
    if (block) {
      if (line === ')') block = false;
      else if (line) requires.push(line.split(/\s+/)[0].replace(/^"|"$/g, ''));
    } else if (/^require\s*\($/.test(line)) block = true;
    else {
      const single = line.match(/^require\s+"?([^\s"(]+)"?\s+\S+$/);
      if (single) requires.push(single[1]);
    }
  }
  return {module, requires};
}

// The module this repository releases, when its root go.mod names one under the prefix.
export function ownModule(read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) {
  const text = read('go.mod');
  if (!text) return null;
  const {module} = parseGoMod(text);
  return module?.startsWith(prefix) ? module : null;
}

// The modules under the prefix a go.mod requires: what a take-up takes.
export function ownRequires(text) {
  const {module, requires} = parseGoMod(text);
  return [...new Set(requires.filter(path => path.startsWith(prefix) && path !== module))].sort();
}

// The fleet repositories with the go suite whose root go.mod requires a module.
export async function consumers(module, {token, repos = fleet(), base = server(), self = currentRepository()} = {}) {
  const found = [];
  for (const [repository, entry] of Object.entries(repos)) {
    if (repository === self || !entry.suites?.includes('go')) continue;
    const repo = await request(`${base}/api/v1/repos/${repository}`, {token, allow404: true});
    if (!repo || repo.empty || repo.archived) continue;
    const text = await request(`${base}/api/v1/repos/${repository}/raw/go.mod?ref=${encodeURIComponent(repo.default_branch)}`, {token, allow404: true, text: true});
    if (text && parseGoMod(text).requires.includes(module)) found.push({repository, workflow: 'go/dependencies.yml', branch: repo.default_branch});
  }
  return found;
}

// A released module's take-up, dispatched to each repository that requires it.
export async function dispatchConsumers(module, token = process.env.DISPATCH_TOKEN) {
  if (!token) throw new Error('dispatching take-ups requires a Forgejo write token from actions/forgejo-token');
  for (const target of await consumers(module, {token})) {
    await post(`${server()}/api/v1/repos/${target.repository}/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`, {ref: target.branch}, {token});
    console.log(`${target.repository}: ${target.workflow} takes up ${module}`);
  }
}
