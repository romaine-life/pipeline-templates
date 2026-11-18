import path from 'node:path';
import {capture, readJSON, safePath, templates} from './lib.mjs';
import {currentTopics, isSettingTopic, resolve, rustBuilds, validTopic, valueSelectors} from './topics.mjs';
import {layout} from './layout.mjs';

// A fleet entry: its suites, its setting topics (topics.mjs), and the values a convention
// doesn't decide yet.
const fields = {
  suites: null, topics: null,
  rust: ['features', 'noDefaultFeatures', 'platformFeatures'],
  release: ['assets', 'dispatch', 'rustTargets', 'external', 'dotnetProjects', 'archives', 'image','mirror','assetNames','sourceLists','manifest','checksumFiles','checksumManifest'],
  cmake: ['buildPlatform'], dotnet: ['sdk', 'buildPlatform'], python: ['buildPlatform'],
  service: ['postgres', 'manticore', 'greenmail'], greenmail: ['users']
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
  // A value a topic selects is there exactly when the topic is.
  for (const [topic, [name, field]] of Object.entries(valueSelectors)) {
    if ((value[name]?.[field] !== undefined) !== topics.includes(topic)) throw new Error(`${where}: ${name}.${field} goes with topic ${topic}`);
  }
  if (value.release?.rustTargets !== undefined && !Array.isArray(value.release.rustTargets)) throw new Error(`${where}: release.rustTargets must be an array`);
  for (const part of value.release?.rustTargets || []) {
    const platform = Object.keys(rustBuilds).find(p => rustBuilds[p] === part?.target);
    if (!platform || !topics.includes(`rust-build-${platform}`)) throw new Error(`${where}: release.rustTargets ${part?.target} needs its rust-build- topic`);
    if (Object.keys(part).length < 2) throw new Error(`${where}: release.rustTargets holds a target's values; its topic alone builds it`);
  }
  if (new Set((value.release?.rustTargets || []).map(part => part.target)).size !== (value.release?.rustTargets || []).length) throw new Error(`${where}: release.rustTargets names a target twice`);
  settings(resolve(value, topics, /^[\w.-]+\/[\w.-]+$/.test(where) ? where : undefined));
  return value;
}

// The settings a repository runs with: its entry, resolved with its topics.
function settings(value) {
  for (const [section, field] of [['rust','features'],['release','assets'],['release','dispatch']]) {
    if (value[section]?.[field] !== undefined && !Array.isArray(value[section][field])) throw new Error(`${section}.${field} must be an array`);
  }
  if (value.rust?.noDefaultFeatures !== undefined && typeof value.rust.noDefaultFeatures !== 'boolean') throw new Error('rust.noDefaultFeatures must be boolean');
  // A Go library that is also a cluster service (fzt-frontend) releases both under one tag.
  if (value.release?.module && (['toolchains', 'external', 'assets'].some(f => value.release[f] !== undefined) || ![undefined, 'cluster'].includes(value.release.image))) throw new Error('release.module tags a Go library and publishes its source, with at most its cluster image; it builds nothing else');
  const toolchains = value.release?.toolchains || [];
  if(value.release?.rustTargets && (!Array.isArray(value.release.rustTargets) || !value.release.rustTargets.length))throw new Error('release.rustTargets must be a nonempty array');
  for (const part of value.release?.rustTargets || []) {
    if (!/^[\w]+-[\w]+-[\w]+(?:-[\w]+)?$/.test(part.target || '') || part.target.includes('apple')) throw new Error('Rust targets need target triples; Apple targets belong in release.external');
    if (Object.keys(part).some(key => !['target', 'package', 'features', 'noDefaultFeatures', 'glibc'].includes(key))) throw new Error('release.rustTargets take target, package, features, noDefaultFeatures and glibc');
    // A workspace that ships a different program per platform names its package: Cargo builds it
    // alone, with that package's own default features, instead of unifying every member's.
    if (part.package !== undefined && (typeof part.package !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part.package))) throw new Error('release.rustTargets package is a Cargo package name');
    if (part.glibc !== undefined && (!part.target.endsWith('-unknown-linux-gnu') || !/^2\.\d+$/.test(part.glibc))) throw new Error('release.rustTargets glibc is a 2.N floor for a -unknown-linux-gnu target');
    // The Linux runner is x86_64: another architecture links through zig, which a glibc floor selects.
    if (part.target.endsWith('-unknown-linux-gnu') && !part.target.startsWith('x86_64-') && part.glibc === undefined) throw new Error(`${part.target} builds through zig: give it a glibc floor`);
  }
  if (value.release?.image && !['cluster','web'].includes(value.release.image)) throw new Error('release.image must be cluster or web');
  if (value.release?.image && !value[value.release.image]?.image) throw new Error('joined image release needs the corresponding image configuration');
  const externalIds=new Set(),externalAssets=new Set();
  for (const part of value.release?.external || []) {
    if (part.provider && !['github','forgejo'].includes(part.provider)) throw new Error('external release provider must be github or forgejo');
    if (!/^[a-z][a-z0-9-]*$/.test(part.id || '') || (['local','plan'].includes(part.id) || part.id.startsWith('request-')) || externalIds.has(part.id) || !/^(?:romaine-life|nelsong6)\/[\w.-]+$/.test(part.repository || '') || !/^[\w.-]+\.ya?ml$/.test(part.workflow || '') || !Array.isArray(part.assets) || !part.assets.length) throw new Error('external release parts need unique id, repository, workflow and asset names');
    for (const asset of part.assets) if (!/^[\w.+-]+$/.test(asset.replaceAll('{tag}','tag').replaceAll('{version}','version'))) throw new Error('external assets must be plain file names');
    for (const asset of part.assets) {if (externalAssets.has(asset)) throw new Error('external release asset names must be unique across parts');externalAssets.add(asset);}
    externalIds.add(part.id);
  }
  for (const project of value.release?.dotnetProjects || []) safePath(project);
  for(const name of [...Object.values(value.release?.sourceLists || {}),...(value.release?.checksumFiles || []),...[value.release?.manifest,value.release?.checksumManifest].filter(Boolean)])if(typeof name!=='string' || !/^[\w.*+{}-]+$/.test(name))throw new Error('release metadata names must be plain file names');
  if(value.release?.assetNames && (Array.isArray(value.release.assetNames) || typeof value.release.assetNames!=='object'))throw new Error('release.assetNames must be an object');
  if(value.release?.sourceLists && (Array.isArray(value.release.sourceLists) || typeof value.release.sourceLists!=='object' || Object.keys(value.release.sourceLists).some(part=>!(value.release.rustTargets || [{target:'x86_64-unknown-linux-gnu'}]).some(t=>part===`rust-${t.target}`))))throw new Error('release.sourceLists must name declared Rust parts');
  for(const [part,mapping] of Object.entries(value.release?.assetNames || {})) {
    if(!/^[a-z][a-z0-9_-]*$/.test(part) || !mapping || Array.isArray(mapping) || typeof mapping!=='object')throw new Error('release.assetNames maps part/target IDs to rename maps');
    for(const [source,target] of Object.entries(mapping)) {
      safePath(source);
      if(source.split('*').length>2 || typeof target!=='string' || !/^[\w.*+{}-]+$/.test(target) || target.startsWith('ci-release-') || target.split('*').length>2 || target.replaceAll('{tag}','').replaceAll('{version}','').includes('{'))throw new Error('asset rename needs one optional wildcard and a plain published name with {tag}/{version}');
    }
  }
  for (const archive of value.release?.archives || []) {
    if(Object.keys(archive).some(k=>!['toolchain','targets','name','sources','entries'].includes(k)))throw new Error('unknown archive field');
    if (!/^[\w.-]+\.(?:zip|tar\.gz)$/.test((archive.name || '').replaceAll('{tag}','tag').replaceAll('{version}','version')) || !Array.isArray(archive.sources) || !archive.sources.length) throw new Error('release.archives need a ZIP name and source files');
    for (const file of archive.sources) {safePath(file);if(file==='dist')throw new Error('archive sources must name files or subdirectories, not the output root');}
    if(archive.targets && (!Array.isArray(archive.targets) || !archive.targets.length))throw new Error('archive.targets must be nonempty');
    for(const [source,target] of Object.entries(archive.entries || {})){safePath(source);if(!/^[\w.+-]+$/.test(target))throw new Error('archive entries must name plain files');}
  }
  for (const p of value.release?.assets || []) safePath(p);
  for (const target of value.release?.dispatch || []) {
    if (!/^(?:romaine-life|nelsong6)\/[\w.-]+$/.test(target.repository || '') || Object.keys(target).some(k=>!['repository','workflow'].includes(k))) throw new Error('release.dispatch must name an owned repository and optional workflow');
    if (target.workflow) safePath(target.workflow);
  }
  for (const [name, image] of Object.entries(value.service || {})) {
    if (typeof image !== 'string' || !/^artifacts\.home\.romaine\.life\/[\w./:-]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`service.${name} must be a digest-pinned Artifact Keeper image`);
  }
  if (value.greenmail && !value.service?.greenmail) throw new Error('greenmail.users needs service.greenmail');
  const users = value.greenmail?.users;
  if (users !== undefined && (!Array.isArray(users) || !users.length || users.some(user => typeof user !== 'string' || !/^[\w.+-]+:[^\s,@:]+@[\w.-]+$/.test(user)))) {
    throw new Error('greenmail.users are login:password@domain, as GreenMail takes them');
  }
  return value;
}
