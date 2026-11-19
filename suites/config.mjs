import path from 'node:path';
import {capture, readJSON, templates} from './lib.mjs';
import {currentTopics, isSettingTopic, resolve, validTopic} from './topics.mjs';
import {layout} from './layout.mjs';

// A fleet entry: its suites, its setting topics (topics.mjs), and the values a convention
// doesn't decide yet.
const fields = {
  suites: null, topics: null,
  rust: ['features', 'noDefaultFeatures', 'platformFeatures']
};
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
  for (const [key, section] of Object.entries(value)) {
    if (!(key in fields)) throw new Error(`${where}: unknown field ${key}`);
    if (fields[key]) {
      if (!section || Array.isArray(section) || typeof section !== 'object') throw new Error(`${where}: ${key} must be an object`);
      for (const field of Object.keys(section)) if (!fields[key].includes(field)) throw new Error(`${where}: unknown field ${key}.${field}`);
    }
  }
  const topics = value.topics ?? [];
  if (!Array.isArray(topics) || new Set(topics).size !== topics.length || topics.some(topic => !validTopic(topic) || !isSettingTopic(topic))) {
    throw new Error(`${where}: topics must name each setting topic once (suites are ci- topics, from suites)`);
  }
  // Forgejo keeps at most 25 topics on a repository.
  if (value.suites.length + topics.length > 25) throw new Error(`${where}: more than 25 topics`);
  if (topics.includes('web-static') && topics.includes('web-image')) throw new Error(`${where}: a web app deploys a Static Web App (web-static) or an image (web-image), not both`);
  settings(resolve(value, topics, /^[\w.-]+\/[\w.-]+$/.test(where) ? where : undefined));
  return value;
}

// The settings a repository runs with: its entry, resolved with its topics.
function settings(value) {
  if (value.rust?.features !== undefined && !Array.isArray(value.rust.features)) throw new Error('rust.features must be an array');
  if (value.rust?.noDefaultFeatures !== undefined && typeof value.rust.noDefaultFeatures !== 'boolean') throw new Error('rust.noDefaultFeatures must be boolean');
  // A Go library that is also a cluster service (fzt-frontend) releases both under one tag.
  if (value.release?.module && (['toolchains', 'external', 'assets'].some(f => value.release[f] !== undefined) || ![undefined, 'cluster'].includes(value.release.image))) throw new Error('release.module tags a Go library and publishes its source, with at most its cluster image; it builds nothing else');
  const toolchains = value.release?.toolchains || [];
  if (value.release?.image && !['cluster','web'].includes(value.release.image)) throw new Error('release.image must be cluster or web');
  if (value.release?.image && !value[value.release.image]?.image) throw new Error('joined image release needs the corresponding image configuration');
  return value;
}
