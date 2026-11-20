import path from 'node:path';
import {capture, readJSON, templates} from './lib.mjs';
import {currentTopics, isSettingTopic, providerType, resolve, validTopic} from './topics.mjs';
import {layout} from './layout.mjs';

// A fleet entry: its suites, its setting topics (topics.mjs), and nas, which says homesvc on
// the NAS applies the repo's merged default branch there and strip-owner waits for it
// (at-home-tools and agent-tools, AHT-177); everything else follows from the repository
// (layout.mjs, conventions.mjs).
const fields = ['suites', 'topics', 'nas'];
export const suiteNames = ['default', 'go', 'rust', 'cmake', 'dotnet', 'python', 'release', 'cluster-service', 'web-app', 'tofu', 'docs', 'powershell'];

export function currentRepository() {
  if (process.env.CI_REPOSITORY) return process.env.CI_REPOSITORY;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = capture('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '');
  return url.split(/[/:]/).slice(-2).join('/');
}

export function fleet(file = process.env.CI_FLEET || path.join(templates, 'fleet.json')) {
  const value = readJSON(file);
  if (!value.repos || Array.isArray(value.repos) || typeof value.repos !== 'object') throw new Error('fleet.json needs a repos map');
  for (const [repo, entry] of Object.entries(value.repos)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`fleet.json: not an owner/repo name: ${repo}`);
    validate(entry, repo);
  }
  return value.repos;
}

// A repository's settings are its entry in the fleet list, with the selections its topics
// make (read from Forgejo when it runs, topics.mjs), the names its own name gives, and what
// its files decide (layout.mjs); one the list leaves out has none.
export function config(repo = currentRepository(), repos = fleet(), topics, checkout) {
  const entry = repos[repo];
  if (!entry) return {suites: []};
  return layout(settings(resolve(entry, topics ?? currentTopics(), repo)), repo, checkout);
}

// A fleet entry, as the list holds it; the settings its topics give it must hold too.
export function validate(value, where = 'fleet entry') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${where} must be an object`);
  if (!Array.isArray(value.suites) || value.suites.some(s => !suiteNames.includes(s) || s === 'default') || new Set(value.suites).size !== value.suites.length) {
    throw new Error(`${where}: suites must name each suite once (default is always included)`);
  }
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  if (value.nas !== undefined && value.nas !== true) throw new Error(`${where}: nas is true or left out`);
  const topics = value.topics ?? [];
  if (!Array.isArray(topics) || new Set(topics).size !== topics.length || topics.some(topic => !validTopic(topic) || !isSettingTopic(topic))) {
    throw new Error(`${where}: topics must name each setting topic once (suites are ci- topics, from suites)`);
  }
  // Forgejo keeps at most 25 topics on a repository.
  if (value.suites.length + topics.length > 25) throw new Error(`${where}: more than 25 topics`);
  if (topics.includes('web-static') && topics.includes('web-image')) throw new Error(`${where}: a web app deploys a Static Web App (web-static) or an image (web-image), not both`);
  const repo = /^[\w.-]+\/[\w.-]+$/.test(where) ? where : undefined;
  if (topics.includes('release-tofu-provider') && repo) providerType(repo);
  settings(resolve(value, topics, repo));
  return value;
}

// The settings a repository runs with: its entry, resolved with its topics.
function settings(value) {
  // A Go library that is also a cluster service (fzt-frontend) releases both under one tag.
  if (value.release?.module && (['toolchains', 'external', 'assets'].some(f => value.release[f] !== undefined) || ![undefined, 'cluster'].includes(value.release.image))) throw new Error('release.module tags a Go library and publishes its source, with at most its cluster image; it builds nothing else');
  // A provider's versions are tofu's, X.Y.Z, and it ships programs.
  if (value.release?.tofuProvider && (value.release.suffix || value.release.module || !value.release.toolchains?.length)) throw new Error('release.tofuProvider builds a provider program with a release toolchain, versioned X.Y.Z');
  if (value.release?.image && !['cluster','web'].includes(value.release.image)) throw new Error('release.image must be cluster or web');
  if (value.release?.image && !value[value.release.image]?.image) throw new Error('joined image release needs the corresponding image configuration');
  return value;
}
