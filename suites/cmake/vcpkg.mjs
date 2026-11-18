import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, kept} from '../lib.mjs';

// A project with a vcpkg.json builds its dependencies through vcpkg in manifest mode, the
// vcpkg Visual Studio ships (VCPKG_ROOT, which msvc() takes from vcvarsall): its preset names
// $env{VCPKG_ROOT}'s toolchain file. Built packages are kept on the runner, and vcpkg
// downloads only through Artifact Keeper (vcpkg-fetch.mjs). Its registry, microsoft/vcpkg, is
// read from Forgejo's copy, which holds the commits forgejo's k8s/copies.txt lists
// (FORGEJO-29), and a port's private Forgejo source with the pipeline's token.
export function vcpkgEnvironment({root = process.env.VCPKG_ROOT, token = process.env.PRIVATE_GIT_TOKEN, server = process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life', cache = () => kept('vcpkg')} = {}) {
  if (!root || !fs.existsSync(path.join(root, 'scripts/buildsystems/vcpkg.cmake'))) throw new Error('vcpkg.json needs vcpkg: VCPKG_ROOT names no vcpkg (Visual Studio\'s comes with its C++ build tools)');
  server = server.replace(/\/$/, '');
  const fetcher = fileURLToPath(new URL('./vcpkg-fetch.mjs', import.meta.url));
  const env = {
    VCPKG_DEFAULT_BINARY_CACHE: cache(),
    VCPKG_DISABLE_METRICS: '1',
    VCPKG_MAX_CONCURRENCY: '4',
    X_VCPKG_ASSET_SOURCES: `clear;x-script,"${process.execPath}" "${fetcher}" "{url}" "{dst}";x-block-origin`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${server}/microsoft/vcpkg.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/microsoft/vcpkg',
  };
  // On a PC, git signs in to Forgejo through its own credential helper.
  if (token) Object.assign(env, {GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`});
  return env;
}

// Forgejo's copy of microsoft/vcpkg holds only the commits listed for it, so a baseline it
// lacks is named here rather than as vcpkg's failed fetch.
export async function checkBaseline({manifest = 'vcpkg.json', token = process.env.PRIVATE_GIT_TOKEN, server = process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life'} = {}) {
  const baseline = JSON.parse(fs.readFileSync(manifest, 'utf8'))['builtin-baseline'];
  if (!baseline || !token) return;
  const response = await fetch(`${server.replace(/\/$/, '')}/api/v1/repos/microsoft/vcpkg/git/commits/${baseline}?stat=false&verification=false&files=false`,
    {headers: {Authorization: `token ${token}`}, signal: AbortSignal.timeout(30000)});
  if (response.status === 404) throw new Error(`Forgejo's microsoft/vcpkg lacks vcpkg.json's builtin-baseline ${baseline}: add it to microsoft/vcpkg's lines in forgejo's k8s/copies.txt`);
  if (!response.ok) throw new Error(`looking up ${baseline} in Forgejo's microsoft/vcpkg: HTTP ${response.status}`);
}

// vcpkg builds each port under the build directory, whose path is already long; a try-compile
// there passes MSVC's 250-character object path, and libevent's checks then fail. Each build
// directory gets its own short folder for them.
export function vcpkgArguments(dir, trees = kept(`vcpkg-trees/${hash(dir).slice(0, 12)}`)) {
  return [`-DVCPKG_INSTALL_OPTIONS=--x-buildtrees-root=${trees.replaceAll('\\', '/')}`];
}

// The configure arguments a vcpkg.json project needs, after its environment is set.
export async function vcpkg(dir) {
  if (!fs.existsSync('vcpkg.json')) return [];
  Object.assign(process.env, vcpkgEnvironment());
  await checkBaseline();
  return vcpkgArguments(dir);
}
