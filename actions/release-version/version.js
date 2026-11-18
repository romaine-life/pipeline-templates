'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The base version a file declares, as a series prefix: "0.25.1" -> "v0.25.1". A
// pre-release or build suffix on it (3.6a-rc1) is not part of the series.
function prefixFrom(file, text) {
  const name = path.basename(file).toLowerCase();
  let version;
  if (name === 'cargo.toml') {
    // The version line of [package], or of [workspace.package]: up to the next table header.
    const table = text.match(/^\[(?:workspace\.)?package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const line = table && table[1].match(/^version\s*=\s*"([^"]+)"/m);
    version = line && line[1];
  } else if (name === 'cmakelists.txt') {
    const m = text.match(/PACKAGE_VERSION\s*=?\s*"?([0-9][^"\s)]*)/) ||
      text.match(/project\s*\([^)]*\bVERSION\s+([0-9][^\s)]*)/i);
    version = m && m[1];
  } else if (name === 'package.json') {
    version = JSON.parse(text).version;
  } else {
    throw new Error(`prefix-from: ${file} is not a Cargo.toml, CMakeLists.txt or package.json`);
  }
  if (!version) throw new Error(`prefix-from: ${file} declares no version`);
  version = version.split(/[-+]/)[0];
  if (!/^[0-9][0-9A-Za-z.]*$/.test(version)) throw new Error(`prefix-from: ${file} has version ${version}, not a release number`);
  return `v${version}`;
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The series a repo is on when no prefix names one: its newest vX.Y.N tag's vX.Y (v1.25 from
// v1.25.37.0, with suffix .0), else v0.1. A new series starts with its first tag made by hand,
// such as v0.2.0 on the commit it starts at.
function seriesFromTags(names, suffix = '', component = '') {
  const lead = component ? `${component}-` : '';
  const pattern = new RegExp(`^${escape(lead)}v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)${escape(suffix)}$`);
  const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let best;
  for (const name of names) {
    const m = name.match(pattern);
    const version = m && m.slice(1).map(Number);
    if (version && (!best || newer(version, best) > 0)) best = version;
  }
  return `${lead}v${best ? `${best[0]}.${best[1]}` : '0.1'}`;
}

async function releaseVersion({api, token, series, component = '', suffix = '', publish, sha, pullRequest, run, fetch = globalThis.fetch, log = console.log}) {
  if (!token) throw new Error('missing token');
  const headers = {Authorization: `token ${token}`, 'Content-Type': 'application/json'};
  const call = (method, route, body) =>
    fetch(`${api}${route}`, {method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  const ok = async (method, route, body) => {
    const response = await call(method, route, body);
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
    return response;
  };

  const all = async () => {
    const found = [];
    for (let page = 1, seen = 0, total = Infinity; seen < total; page++) {
      const response = await ok('GET', `/tags?limit=50&page=${page}`);
      total = Number(response.headers.get('x-total-count') ?? 0);
      const batch = await response.json();
      if (!batch.length) break;
      seen += batch.length;
      found.push(...batch);
    }
    return found;
  };
  if (!series) {
    series = seriesFromTags((await all()).map(tag => tag.name), suffix, component);
    log(`Series ${series}, from the newest tag`);
  } else if (component) series = `${component}-${series}`;

  // Every tag in the series, by number, and the commit each is on.
  const pattern = new RegExp(`^${escape(series)}\\.(0|[1-9][0-9]*)${escape(suffix)}$`);
  const numbered = async () => {
    const found = [];
    for (const tag of await all()) {
      const m = tag.name.match(pattern);
      if (m) found.push({name: tag.name, number: Number(m[1]), sha: tag.commit && tag.commit.sha});
    }
    return found.sort((a, b) => b.number - a.number);
  };
  const next = tags => (tags.length ? tags[0].number + 1 : 0);

  if (publish) {
    if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error(`sha ${sha} is not a commit`);
    for (let attempt = 0; attempt < 10; attempt++) {
      const tags = await numbered();
      const mine = tags.find(t => t.sha === sha);
      if (mine) {
        log(`${sha} is already ${mine.name}`);
        return {version: mine.name, tag: mine.name, reserved: false};
      }
      const name = `${series}.${next(tags)}${suffix}`;
      const response = await call('POST', '/tags', {tag_name: name, target: sha});
      if (response.ok) {
        log(`Reserved ${name} on ${sha}`);
        return {version: name, tag: name, reserved: true};
      }
      // Another run took the number first (409, or 422 on older Forgejo): read again.
      if (response.status !== 409 && response.status !== 422) throw new Error(`POST /tags ${name}: HTTP ${response.status}`);
      log(`${name} was taken while reserving it; numbering again`);
    }
    throw new Error('the series kept moving while reserving a tag; ten tries');
  }

  if (!/^[0-9]+$/.test(String(run || ''))) throw new Error(`run number ${run} is not a number`);
  const from = /^[0-9]+$/.test(String(pullRequest || '')) ? `pr${pullRequest}.${run}` : `run${run}`;
  const version = `${series}.${next(await numbered())}${suffix}-${from}`;
  log(`Build ${version}, not released`);
  return {version, tag: '', reserved: false};
}

module.exports = {releaseVersion, prefixFrom, seriesFromTags};

if (require.main === module) {
  const input = name => (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
  (async () => {
    const prefix = input('prefix');
    const file = input('prefix-from');
    if (prefix && file) throw new Error('give prefix or prefix-from, not both');
    const component = input('component');
    let series = prefix;
    if (file) {
      const full = path.resolve(process.env.GITHUB_WORKSPACE || '.', file);
      series = prefixFrom(full, fs.readFileSync(full, 'utf8'));
    }
    if (series && !/^v[0-9][0-9A-Za-z.]*$/.test(series)) throw new Error(`prefix ${series} is not v followed by a version, such as v0.1`);
    if (component && !/^[a-z][a-z0-9-]*$/.test(component)) throw new Error(`component ${component} is not a lowercase name`);
    const suffix = input('suffix');
    if (!/^(\.[0-9]+)*$/.test(suffix)) throw new Error(`suffix ${suffix} is not fixed numeric parts, such as .0`);
    const result = await releaseVersion({
      api: `${process.env.GITHUB_SERVER_URL}/api/v1/repos/${input('repository')}`,
      token: input('token'),
      series,
      component,
      suffix,
      publish: input('publish') === 'true',
      sha: input('sha'),
      pullRequest: input('pull-request'),
      run: process.env.GITHUB_RUN_NUMBER,
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nreserved=${result.reserved}\n`);
  })().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
