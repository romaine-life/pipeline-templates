// A repository's CI selections are its Forgejo topics (PIPT-12): the Fleet workflow applies
// them from fleet.json, and a suite reads them from Forgejo's API when it runs, never from the
// pull request's checkout, so a change can't alter its own gate. The suite action reads them
// once per job into CI_TOPICS; ci-check reads them the same way before it runs the checks.
// Topics starting `ci-` are the Forgejo patch's suites, not settings.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {request} from './lib.mjs';

const testTools = ['go', 'rust', 'cmake', 'dotnet', 'python'];
export const releaseToolchains = ['go', 'rust', 'npm', 'python', 'dotnet', 'cmake', 'powershell'];
export const rustBuilds = {
  'windows-amd64': 'x86_64-pc-windows-msvc', 'windows-arm64': 'aarch64-pc-windows-msvc',
  'linux-amd64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const lints = ['typos', 'machete', 'audit'];
const serviceNames = ['postgres', 'manticore', 'greenmail'];

// Selectors that pick a value fleet.json still holds (to become conventions or repository
// files): the topic decides whether it applies, the value what it is.
export const valueSelectors = {
  'cluster-image': ['cluster', 'image'], 'web-image': ['web', 'image'], 'web-static': ['web', 'staticApp'],
  'release-archive': ['release', 'archives'],
  'release-source-list': ['release', 'sourceLists'], 'release-external': ['release', 'external'],
  ...Object.fromEntries(serviceNames.map(name => [`service-${name}`, ['service', name]])),
};

// Every topic the suites read, and so every topic Fleet owns besides `ci-`.
export const settingTopics = [
  ...testTools.flatMap(tool => [`${tool}-test-linux`, `${tool}-test-windows`]),
  'go-race', ...lints.map(lint => `rust-${lint}`), 'windows-powershell',
  ...serviceNames.map(name => `service-${name}`),
  'cluster-image', 'web-image', 'web-static', 'web-history',
  'release-source', 'release-module', ...releaseToolchains.map(kind => `release-${kind}`),
  'version-from-manifest', 'version-four-part', 'home-sync',
  ...Object.keys(rustBuilds).map(platform => `rust-build-${platform}`),
  'release-archive', 'release-source-list', 'release-external',
];
const known = new Set(settingTopics);
export const isSettingTopic = topic => known.has(topic);
// What Forgejo accepts as a topic.
export const validTopic = topic => typeof topic === 'string' && /^[a-z0-9][-.a-z0-9]*$/.test(topic) && topic.length <= 35;

// The settings the suites read, from a fleet entry and the topics the repository carries:
// a topic turns its setting on; without it the setting is off (tests run on Linux only).
// The values a selector picks stay in the entry and apply only while their topic is set.
export function resolve(entry, topics) {
  const on = new Set(topics.filter(isSettingTopic));
  const cfg = structuredClone(entry);
  delete cfg.topics;
  const section = name => (cfg[name] ??= {});
  for (const tool of testTools) {
    const linux = on.has(`${tool}-test-linux`), windows = on.has(`${tool}-test-windows`);
    if (linux || windows) section(tool).platforms = [...(linux || !windows ? ['ubuntu-latest'] : []), ...(windows ? ['windows-latest'] : [])];
  }
  if (on.has('go-race')) section('go').race = ['./...'];
  const rustLints = lints.filter(lint => on.has(`rust-${lint}`));
  if (rustLints.length) section('rust').lints = rustLints;
  if (on.has('windows-powershell')) section('powershell').windowsPowerShell = true;
  if (on.has('release-source')) section('docs').release = true;
  if (on.has('web-history')) section('web').history = true;
  // A cluster service builds and smoke-tests its own image only with cluster-image;
  // without it, it renders and pins what upstream publishes.
  if (cfg.suites?.includes('cluster-service') && !on.has('cluster-image')) Object.assign(section('cluster'), {build: false, smoke: false});
  for (const [topic, [name, field]] of Object.entries(valueSelectors)) {
    if (!on.has(topic)) { if (cfg[name]) delete cfg[name][field]; continue; }
    if (cfg[name]?.[field] === undefined) throw new Error(`topic ${topic} needs ${name}.${field} in fleet.json`);
  }
  if (cfg.service && !Object.keys(cfg.service).length) delete cfg.service;
  if (on.has('release-module')) section('release').module = true;
  const toolchains = releaseToolchains.filter(kind => on.has(`release-${kind}`));
  if (toolchains.length) section('release').toolchains = toolchains;
  if (on.has('version-from-manifest')) section('release').fromManifest = true;
  if (on.has('version-four-part')) section('release').suffix = '.0';
  if (on.has('home-sync')) section('release').homeSync = true;
  // release.rustTargets holds per-target values (features, a glibc floor); the topics
  // choose the targets.
  const values = new Map((cfg.release?.rustTargets || []).map(part => [part.target, part]));
  const targets = Object.entries(rustBuilds).filter(([platform]) => on.has(`rust-build-${platform}`)).map(([, target]) => values.get(target) || {target});
  if (targets.length) section('release').rustTargets = targets;
  else if (cfg.release) delete cfg.release.rustTargets;
  cfg.topics = [...on].sort();
  return cfg;
}

// The topics the running repository carries, as the suite action or ci-check read them.
export function currentTopics(value = process.env.CI_TOPICS) {
  if (value === undefined) throw new Error("the repository's topics weren't read: the suite action sets CI_TOPICS from Forgejo's API (suites/topics.mjs), and ci-check reads them itself");
  const topics = JSON.parse(value);
  if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string')) throw new Error('CI_TOPICS must be a JSON list of topic names');
  return topics;
}

const server = () => (process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life').replace(/\/$/, '');
export async function readTopics(repo, {token = process.env.TOKEN, get = request} = {}) {
  const {topics} = await get(`${server()}/api/v1/repos/${repo}/topics?limit=50`, {token});
  if (!Array.isArray(topics)) throw new Error(`${repo}: Forgejo returned no topic list`);
  return topics;
}

// A PC's sign-in to Forgejo, as the pr tools find it (agent-tools/forgejo): FORGEJO_TOKEN,
// else the token git's credential helper holds for the host, never prompting.
export function localToken(host = new URL(server()).host) {
  if (process.env.FORGEJO_TOKEN) return process.env.FORGEJO_TOKEN;
  const result = spawnSync('git', ['credential', 'fill'], {input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8',
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'}});
  const token = result.status === 0 ? result.stdout.match(/^password=(.*)$/m)?.[1] : '';
  if (!token) throw new Error(`no sign-in for ${host}: set FORGEJO_TOKEN or store a Forgejo token in git's credential helper`);
  return token;
}

// The suite action, given the job's token: the running repository's topics, into CI_TOPICS
// for the rest of the job.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.env.CI_REPOSITORY || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('topics.mjs runs in a job, which names its repository');
  const topics = await readTopics(repo);
  console.log(`${repo} topics: ${topics.join(' ') || '(none)'}`);
  if (!process.env.GITHUB_ENV) throw new Error('topics.mjs runs in a job: it sets CI_TOPICS through GITHUB_ENV');
  fs.appendFileSync(process.env.GITHUB_ENV, `CI_TOPICS=${JSON.stringify(topics)}\n`);
}
