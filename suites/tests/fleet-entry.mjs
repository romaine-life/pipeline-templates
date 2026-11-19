import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rustBuilds} from '../topics.mjs';

// Tests give their repository settings the way production does: as its entry in a fleet
// list, here a temporary one CI_FLEET names, outside the repository under test, and the
// topics Fleet would set on it, in CI_TOPICS as the suite action reads them.
let current = {};
export function fleetEntry(settings = {}, repo = process.env.GITHUB_REPOSITORY || 'test/probe') {
  const {version, ...rest} = settings;
  current = {suites: [], ...rest};
  const {entry, topics} = entryFor(current);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-')), 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({repos: {[repo]: {...entry, topics}}}));
  process.env.CI_FLEET = file;
  process.env.CI_TOPICS = JSON.stringify(topics);
  process.env.GITHUB_REPOSITORY ??= repo;
  return file;
}
export const currentEntry = () => structuredClone(current);

// Settings as the suites read them (config.mjs), split into a fleet entry and the setting
// topics that select them (topics.mjs resolve is its inverse).
export function entryFor(settings) {
  const entry = structuredClone(settings), topics = [];
  const take = (name, field) => {
    const value = entry[name]?.[field];
    if (entry[name]) { delete entry[name][field]; if (!Object.keys(entry[name]).length) delete entry[name]; }
    return value;
  };
  const flag = (name, field, topic) => { const value = take(name, field); if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name}.${field} is a flag`); if (value) topics.push(topic); };
  for (const tool of ['go', 'rust', 'cmake', 'dotnet', 'python']) {
    const platforms = take(tool, 'platforms') || ['ubuntu-latest'];
    if (platforms.includes('windows-latest')) topics.push(...(platforms.includes('ubuntu-latest') ? [`${tool}-test-linux`] : []), `${tool}-test-windows`);
  }
  const race = take('go', 'race');
  if (race?.length) { if (JSON.stringify(race) !== '["./..."]') throw new Error('go-race tests every package'); topics.push('go-race'); }
  for (const lint of take('rust', 'lints') || []) topics.push(`rust-${lint}`);
  flag('powershell', 'windowsPowerShell', 'windows-powershell');
  flag('docs', 'release', 'release-source');
  flag('web', 'history', 'web-history');
  flag('release', 'module', 'release-module');
  flag('release', 'homeSync', 'home-sync');
  for (const kind of take('release', 'toolchains') || []) topics.push(`release-${kind}`);
  const suffix = take('release', 'suffix');
  if (take('release', 'fromManifest')) topics.push('version-from-manifest');
  if (suffix) { if (suffix !== '.0') throw new Error('version-four-part adds .0'); topics.push('version-four-part'); }
  const build = take('cluster', 'build'), smoke = take('cluster', 'smoke');
  if (build !== smoke) throw new Error('cluster-image builds and smoke-tests the image together');
  if (entry.suites.includes('cluster-service')) { if (build !== false) topics.push('cluster-image'); }
  else if (build !== undefined) throw new Error('cluster.build belongs to the cluster-service suite');
  // An image and a Static Web App are named for the repository: the topic alone selects them.
  flag('web', 'image', 'web-image');
  flag('web', 'static', 'web-static');
  // A release joins the image its topic builds (topics.mjs).
  const joined = take('release', 'image');
  if (joined && !entry.suites.includes('release')) entry.suites = [...entry.suites, 'release'];
  if (joined === 'cluster' && !topics.includes('cluster-image')) topics.push('cluster-image');
  if (joined === 'web' && !topics.includes('web-image')) topics.push('web-image');
  const external = take('release', 'external');
  if (external !== undefined) {
    if (JSON.stringify(external) !== '[{"id":"build","workflow":"build.yml"}]') throw new Error("release-external is the repository's build.yml");
    topics.push('release-external');
  }
  // A service's image is the repository's (ci/services.json, servicesFile below); the topic selects it.
  for (const name of Object.keys(entry.service || {})) topics.push(`service-${name}`);
  delete entry.service; delete entry.greenmail;
  const parts = take('release', 'rustTargets');
  for (const part of parts || []) {
    const platform = Object.keys(rustBuilds).find(p => rustBuilds[p] === part.target);
    if (!platform) throw new Error(`no rust-build- topic builds ${part.target}`);
    if (Object.keys(part).length > 1) throw new Error(`${part.target}'s values are the repository's Cargo.toml's`);
    topics.push(`rust-build-${platform}`);
  }
  return {entry, topics: [...new Set(topics)].sort()};
}

// The repository's ci/services.json for settings' services (layout.mjs), written under root.
export function servicesFile(settings, root = '.') {
  const value = Object.fromEntries(Object.entries(settings.service || {}).map(([name, image]) => [name, {image}]));
  if (settings.greenmail?.users) value.greenmail.users = settings.greenmail.users;
  fs.mkdirSync(path.join(root, 'ci'), {recursive: true});
  fs.writeFileSync(path.join(root, 'ci', 'services.json'), JSON.stringify(value));
}
