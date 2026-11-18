import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {consumers, forgejoDependencies, jobToken, ownPackage, packageVersion, registry, usesPackages} from '../packages.mjs';

function inDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packages-'));
  const cwd = process.cwd();
  process.chdir(root);
  try { return fn(root); } finally { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); }
}
const reader = files => file => files[file] ?? null;

test("a repository publishes the package its root package.json names in its owner's scope", () => {
  assert.equal(ownPackage('romaine-life', reader({'package.json': '{"name":"@romaine-life/fzt-browser","files":["dist"]}'})).name, '@romaine-life/fzt-browser');
  assert.equal(ownPackage('romaine-life', reader({'package.json': '{"name":"@romaine-life/x","private":true}'})), null);
  assert.equal(ownPackage('romaine-life', reader({'package.json': '{"name":"fzt-desktop"}'})), null);
  assert.equal(ownPackage('romaine-life', reader({})), null);
  assert.throws(() => ownPackage('romaine-life', reader({'package.json': '{"name":"@nelsong6/x"}'})), /outside its owner's scope/);
});

test("a package's version is its release's", () => {
  assert.equal(packageVersion('v0.1.115'), '0.1.115');
  assert.throws(() => packageVersion('v1.2.3.0'), /isn't an npm version/);
  assert.equal(registry('romaine-life', 'https://f.example'), 'https://f.example/api/packages/romaine-life/npm/');
});

test('a job signs in with its own token for the audience asked', async () => {
  const saved = globalThis.fetch;
  let asked;
  globalThis.fetch = async (url, options) => { asked = {url, auth: options.headers.Authorization}; return new Response(JSON.stringify({value: 'jwt'})); };
  try {
    assert.equal(await jobToken('u:1:x', {ACTIONS_ID_TOKEN_REQUEST_URL: 'https://f.example/id?run=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't'}), 'jwt');
    assert.deepEqual(asked, {url: 'https://f.example/id?run=1&audience=u%3A1%3Ax', auth: 'bearer t'});
    await assert.rejects(jobToken('u:1:x', {}), /enable-openid-connect/);
  } finally { globalThis.fetch = saved; }
});

test('a repository reads packages when an .npmrc signs in for them, and takes only those its lock gets from Forgejo', () => inDir(() => {
  fs.mkdirSync('backend');
  fs.writeFileSync('backend/.npmrc', '//forgejo.romaine.life/api/packages/romaine-life/npm/:_authToken=${FORGEJO_PACKAGES_TOKEN?}\n');
  fs.writeFileSync('other.npmrc', '${FORGEJO_PACKAGES_TOKEN}');
  assert.equal(usesPackages(['backend/.npmrc']), true);
  assert.equal(usesPackages(['other.npmrc']), false);
  fs.writeFileSync('backend/package.json', JSON.stringify({dependencies: {'@romaine-life/fzt-browser': '0.1.115', express: '5.1.0'}}));
  fs.writeFileSync('backend/package-lock.json', JSON.stringify({packages: {
    'node_modules/@romaine-life/fzt-browser': {resolved: 'https://f.example/api/packages/romaine-life/npm/@romaine-life/fzt-browser/-/0.1.115/fzt-browser-0.1.115.tgz'},
    'node_modules/express': {resolved: 'https://artifacts.example/npm/npm/express/-/express-5.1.0.tgz'},
    'node_modules/@romaine-life/indirect': {resolved: 'https://f.example/api/packages/romaine-life/npm/@romaine-life/indirect/-/1.0.0/indirect-1.0.0.tgz'}}}));
  assert.deepEqual(forgejoDependencies('backend', 'https://f.example'), ['@romaine-life/fzt-browser']);
  assert.deepEqual(forgejoDependencies('missing', 'https://f.example'), []);
}));

test("a package's take-up goes to each fleet repository whose package.json uses it, by the suite it carries", async () => {
  const repos = {
    'romaine-life/landing-page': {suites: ['web-app', 'tofu']},
    'romaine-life/fzt-desktop': {suites: ['release', 'rust']},
    'romaine-life/lights': {suites: ['go']},
    'romaine-life/gone': {suites: ['web-app']},
  };
  const trees = {
    'romaine-life/landing-page': ['backend/package.json', 'string-box/package.json', 'node_modules/x/package.json'],
    'romaine-life/fzt-desktop': ['package.json'],
    'romaine-life/lights': ['README.md'],
  };
  const manifests = {
    'romaine-life/landing-page/backend/package.json': {dependencies: {express: '5'}},
    'romaine-life/landing-page/string-box/package.json': {dependencies: {'@romaine-life/fzt-browser': '0.1.1'}},
    'romaine-life/fzt-desktop/package.json': {devDependencies: {'@romaine-life/fzt-browser': '0.1.1'}},
  };
  const saved = globalThis.fetch;
  globalThis.fetch = async url => {
    const {pathname} = new URL(url);
    const repo = pathname.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)/)[1];
    if (repo === 'romaine-life/gone') return new Response('', {status: 404});
    if (pathname.endsWith(repo)) return new Response(JSON.stringify({default_branch: 'main'}));
    if (pathname.includes('/git/trees/')) return new Response(JSON.stringify({tree: trees[repo].map(p => ({path: p, type: 'blob'})), truncated: false}));
    const file = decodeURIComponent(pathname.split('/raw/')[1]);
    return new Response(JSON.stringify(manifests[`${repo}/${file}`]));
  };
  try {
    assert.deepEqual(await consumers('@romaine-life/fzt-browser', {token: 't', repos, base: 'https://f.example'}), [
      {repository: 'romaine-life/landing-page', workflow: 'web-app/dependencies.yml', branch: 'main'},
      {repository: 'romaine-life/fzt-desktop', workflow: 'release/dependencies.yml', branch: 'main'},
    ]);
    manifests['romaine-life/lights/README.md'] = null;
    trees['romaine-life/lights'] = ['web/package.json'];
    manifests['romaine-life/lights/web/package.json'] = {dependencies: {'@romaine-life/fzt-browser': '0.1.1'}};
    await assert.rejects(consumers('@romaine-life/fzt-browser', {token: 't', repos, base: 'https://f.example'}), /neither the web-app nor the release suite/);
  } finally { globalThis.fetch = saved; }
});
