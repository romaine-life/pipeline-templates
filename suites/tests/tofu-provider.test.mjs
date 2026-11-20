import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {hash} from '../lib.mjs';
import {validate} from '../config.mjs';
import {resolve} from '../topics.mjs';
import {assembledProviders, packageProviders, providerPackages, providerType, providerVersion, publishProvider} from '../release/tofu-provider.mjs';

function inDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tofu-provider-'));
  try { return fn(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// Each entry of a ZIP's central directory: its name, the system that made it, and its mode.
function entries(zip) {
  const found = [];
  for (let i = 0; i + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue;
    const length = zip.readUInt16LE(i + 28);
    found.push({name: zip.toString('utf8', i + 46, i + 46 + length), system: zip[i + 5], mode: zip.readUInt32LE(i + 38) >>> 16});
  }
  return found;
}

test("a provider's type is its repository's name after terraform-provider-, and its version its release's", () => {
  assert.equal(providerType('romaine-life/terraform-provider-openproject'), 'openproject');
  assert.equal(providerType('romaine-life/terraform-provider-home-cluster'), 'home-cluster');
  assert.throws(() => providerType('romaine-life/openproject'), /isn't named terraform-provider-<type>/);
  assert.throws(() => providerType('romaine-life/terraform-provider-Open'), /isn't named/);
  assert.equal(providerVersion('v0.1.12'), '0.1.12');
  assert.throws(() => providerVersion('v1.25.3.0'), /isn't a provider version/);
});

test('the release-tofu-provider topic makes a provider, which a repository named for one with a release toolchain can be', () => {
  assert.equal(resolve({suites: ['release', 'go']}, ['release-go', 'release-tofu-provider'], 'romaine-life/terraform-provider-x').release.tofuProvider, true);
  validate({suites: ['release', 'go'], topics: ['release-go', 'release-tofu-provider']}, 'romaine-life/terraform-provider-x');
  assert.throws(() => validate({suites: ['release', 'go'], topics: ['release-go', 'release-tofu-provider']}, 'romaine-life/x'), /terraform-provider-<type>/);
  assert.throws(() => validate({suites: ['release', 'go'], topics: ['release-go', 'release-tofu-provider', 'version-four-part']}, 'romaine-life/terraform-provider-x'), /X\.Y\.Z/);
  assert.throws(() => validate({suites: ['release'], topics: ['release-tofu-provider']}, 'romaine-life/terraform-provider-x'), /release toolchain/);
});

test("a build's provider programs become the packages tofu installs, executable once unpacked, the same bytes each time", () => inDir(root => {
  const dist = path.join(root, 'dist');
  const build = () => {
    fs.rmSync(dist, {recursive: true, force: true});
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'terraform-provider-openproject-linux-amd64'), 'linux program');
    fs.writeFileSync(path.join(dist, 'terraform-provider-openproject-windows-amd64.exe'), 'windows program');
    fs.writeFileSync(path.join(dist, 'README.txt'), 'other file');
    return packageProviders({dir: dist, type: 'openproject', version: '0.1.2'});
  };
  assert.deepEqual(build(), ['terraform-provider-openproject_0.1.2_linux_amd64.zip', 'terraform-provider-openproject_0.1.2_windows_amd64.zip']);
  assert.deepEqual(fs.readdirSync(dist).sort(), ['README.txt', 'terraform-provider-openproject_0.1.2_linux_amd64.zip', 'terraform-provider-openproject_0.1.2_windows_amd64.zip']);
  const linux = fs.readFileSync(path.join(dist, 'terraform-provider-openproject_0.1.2_linux_amd64.zip'));
  const windows = fs.readFileSync(path.join(dist, 'terraform-provider-openproject_0.1.2_windows_amd64.zip'));
  assert.deepEqual(Object.fromEntries(Object.entries(unzipSync(linux)).map(([name, data]) => [name, Buffer.from(data).toString()])), {'terraform-provider-openproject_v0.1.2': 'linux program'});
  assert.deepEqual(Object.keys(unzipSync(windows)), ['terraform-provider-openproject_v0.1.2.exe']);
  assert.deepEqual(entries(linux), [{name: 'terraform-provider-openproject_v0.1.2', system: 3, mode: 0o100755}], 'tofu runs the program it unpacks');
  build();
  assert.equal(hash(fs.readFileSync(path.join(dist, 'terraform-provider-openproject_0.1.2_linux_amd64.zip'))), hash(linux));
}));

test('a provider release holds a package for every platform each provider ships for, of one version, and no loose program', () => {
  const both = ['terraform-provider-x_1.0.0_linux_amd64.zip', 'terraform-provider-x_1.0.0_windows_amd64.zip', 'SHA256SUMS'];
  assert.deepEqual(providerPackages(both, 'x', '1.0.0'), {linux_amd64: both[0], windows_amd64: both[1]});
  assert.deepEqual(assembledProviders(both, 'x'), {linux_amd64: both[0], windows_amd64: both[1]});
  assert.throws(() => providerPackages([both[0]], 'x', '1.0.0'), /no terraform-provider-x package for windows_amd64/);
  assert.throws(() => providerPackages([...both, 'terraform-provider-x-linux-arm64'], 'x', '1.0.0'), /outside its package/);
  assert.throws(() => assembledProviders([...both, 'terraform-provider-x_1.0.1_linux_amd64.zip'], 'x'), /1\.0\.0, 1\.0\.1; it holds one version/);
  assert.throws(() => assembledProviders(['SHA256SUMS'], 'x'), /no version/);
});

// Forgejo's release, its job token, and Artifact Keeper, as publishProvider asks them.
function services({held = {}} = {}) {
  const calls = [], packages = {
    'terraform-provider-openproject_0.1.2_linux_amd64.zip': Buffer.from('linux package'),
    'terraform-provider-openproject_0.1.2_windows_amd64.zip': Buffer.from('windows package'),
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET', auth = options.headers?.Authorization;
    calls.push({method, url, auth, body: options.body});
    const {pathname} = new URL(url);
    if (url.startsWith('https://f.example/api/v1/repos/romaine-life/terraform-provider-openproject/releases/tags/v0.1.2')) {
      return Response.json({assets: [...Object.keys(packages), 'SHA256SUMS'].map(name => ({name, browser_download_url: `https://f.example/attachments/${name}`}))});
    }
    if (pathname.startsWith('/attachments/')) return new Response(packages[pathname.slice('/attachments/'.length)]);
    if (url.startsWith('https://f.example/oidc')) return Response.json({value: 'forgejo-jwt'});
    if (url === 'https://artifacts.home.romaine.life/api/v1/auth/ci/token') return auth === 'Bearer forgejo-jwt' ? Response.json({access_token: 'ak-token'}) : new Response('', {status: 401});
    const upload = pathname.match(/^\/terraform\/tofu-providers\/v1\/providers\/romaine-life\/openproject\/0\.1\.2\/(\w+)\/(\w+)$/);
    if (upload && method === 'PUT') return new Response('', {status: held[`${upload[1]}_${upload[2]}`] ? 409 : 201});
    if (pathname === '/terraform/tofu-providers/artifacts.home.romaine.life/romaine-life/openproject/0.1.2.json') {
      return Response.json({archives: Object.fromEntries(Object.entries(held).map(([platform, data]) => [platform, {hashes: [`zh:${hash(data)}`], url: 'x'}]))});
    }
    return new Response('', {status: 404});
  };
  return {calls, packages};
}
const publishing = {tag: 'v0.1.2', repository: 'romaine-life/terraform-provider-openproject', server: 'https://f.example', token: 'forgejo-token',
  env: {ACTIONS_ID_TOKEN_REQUEST_URL: 'https://f.example/oidc?run=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request'}};

test("a provider's release goes to Artifact Keeper with the job's own token, traded for Artifact Keeper's", async () => {
  const saved = globalThis.fetch;
  try {
    const {calls, packages} = services();
    assert.equal(await publishProvider(publishing), 'artifacts.home.romaine.life/romaine-life/openproject');
    assert.ok(calls.some(c => c.url === 'https://f.example/oidc?run=1&audience=https%3A%2F%2Fartifacts.home.romaine.life'), "the job's token is asked for Artifact Keeper's audience");
    const uploads = calls.filter(c => c.method === 'PUT');
    assert.deepEqual(uploads.map(c => [c.url, c.auth, Buffer.from(c.body).toString()]), [
      ['https://artifacts.home.romaine.life/terraform/tofu-providers/v1/providers/romaine-life/openproject/0.1.2/linux/amd64', 'Bearer ak-token', packages['terraform-provider-openproject_0.1.2_linux_amd64.zip'].toString()],
      ['https://artifacts.home.romaine.life/terraform/tofu-providers/v1/providers/romaine-life/openproject/0.1.2/windows/amd64', 'Bearer ak-token', packages['terraform-provider-openproject_0.1.2_windows_amd64.zip'].toString()],
    ]);
    assert.ok(calls.filter(c => c.url.startsWith('https://f.example/')).every(c => c.url.includes('/oidc') || c.auth === 'token forgejo-token'));
  } finally { globalThis.fetch = saved; }
});

test('a version is published once: a rerun finds its own packages there, and a different package is refused', async () => {
  const saved = globalThis.fetch;
  try {
    services({held: {linux_amd64: Buffer.from('linux package'), windows_amd64: Buffer.from('windows package')}});
    await publishProvider(publishing);
    services({held: {linux_amd64: Buffer.from('another build')}});
    await assert.rejects(publishProvider(publishing), /0\.1\.2 for linux_amd64 is already published, and differs/);
    await assert.rejects(publishProvider({...publishing, tag: 'v0.1.2.0'}), /isn't a provider version/);
    await assert.rejects(publishProvider({...publishing, env: {}}), /enable-openid-connect/);
  } finally { globalThis.fetch = saved; }
});
