// Our own OpenTofu providers (OPADMIN-37). A repository named terraform-provider-<type> with
// the release-tofu-provider topic is a provider: its release build publishes each program
// named terraform-provider-<type>-<os>-<arch> (.exe on Windows; a .goreleaser.yaml `binary`
// of terraform-provider-<type>-{{ .Os }}-{{ .Arch }}) as the package tofu installs,
// terraform-provider-<type>_<version>_<os>_<arch>.zip holding terraform-provider-<type>_v<version>.
// Once the release is published, its packages go to Artifact Keeper's hosted repository
// tofu-providers, as artifacts.home.romaine.life/<owner>/<type>, uploaded with the job's own
// Forgejo token: Artifact Keeper trades it for an hour's token that may write there alone, for
// the repositories its publishers.txt lists (nelsong6/artifact-keeper). Nothing stores a
// credential.
import fs from 'node:fs';
import path from 'node:path';
import {zipSync} from 'fflate';
import {hash, request} from '../lib.mjs';
import {jobToken} from '../packages.mjs';
import {providerType} from '../topics.mjs';

export const artifactKeeper = 'https://artifacts.home.romaine.life';
export const hostedRepository = 'tofu-providers';
// The audience Artifact Keeper trusts Forgejo's tokens for (its configure.sh).
export const audience = artifactKeeper;
// Where tofu installs our providers from: the hostname in their source address, and the mirror.
export const sourceHost = new URL(artifactKeeper).host;
export const mirror = `${artifactKeeper}/terraform/${hostedRepository}/`;
// Every provider ships for these; a build may add more.
export const requiredPlatforms = ['linux_amd64', 'windows_amd64'];

export {providerType};

// A provider's version is its release's without the v, and tofu takes only X.Y.Z.
export function providerVersion(tag) {
  const version = String(tag).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release ${tag} isn't a provider version (vX.Y.Z)`);
  return version;
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const binary = type => new RegExp(`^terraform-provider-${escape(type)}-(linux|windows|darwin|freebsd|openbsd)-(amd64|arm64|386|arm)(\\.exe)?$`);
export const packageName = (type, version, platform) => `terraform-provider-${type}_${version}_${platform}.zip`;
const packagePattern = (type, version) => new RegExp(`^terraform-provider-${escape(type)}_${escape(version)}_([a-z0-9]+)_([a-z0-9]+)\\.zip$`);

// The packages a list of release files holds, by platform; a release missing a required
// platform, or holding a provider program outside a package, is refused.
export function providerPackages(files, type, version) {
  const packages = {}, pattern = packagePattern(type, version);
  for (const file of files) {
    const base = path.basename(file), match = base.match(pattern);
    if (match) packages[`${match[1]}_${match[2]}`] = file;
    else if (binary(type).test(base)) throw new Error(`${base} is a provider program outside its package`);
  }
  const missing = requiredPlatforms.filter(platform => !packages[platform]);
  if (missing.length) throw new Error(`the release has no terraform-provider-${type} package for ${missing.join(', ')} (each is built as terraform-provider-${type}-<os>-<arch>)`);
  return packages;
}

// The assembled release's packages, of the one version its build stamped them with.
export function assembledProviders(files, type) {
  const pattern = new RegExp(`^terraform-provider-${escape(type)}_(\\d+\\.\\d+\\.\\d+)_[a-z0-9]+_[a-z0-9]+\\.zip$`);
  const versions = new Set(files.map(file => path.basename(file).match(pattern)?.[1]).filter(Boolean));
  if (versions.size !== 1) throw new Error(`the release holds terraform-provider-${type} packages of ${versions.size ? [...versions].join(', ') : 'no version'}; it holds one version`);
  return providerPackages(files, type, [...versions][0]);
}

// The release build's programs, each as its package: a zip of the one program, named as tofu
// names it and executable once unpacked, written in place of the program. A fixed time keeps a
// build's packages the same bytes whenever they are made.
export function packageProviders({dir = 'dist', type, version}) {
  const made = [];
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(binary(type));
    if (!match) continue;
    const [, os, arch, exe = ''] = match;
    const archive = path.join(dir, packageName(type, version, `${os}_${arch}`));
    const data = fs.readFileSync(path.join(dir, file));
    fs.writeFileSync(archive, zipSync({[`terraform-provider-${type}_v${version}${exe}`]: [data, {os: 3, attrs: 0o100755 << 16, mtime: new Date(2000, 0, 1)}]}));
    fs.rmSync(path.join(dir, file));
    made.push(path.basename(archive));
  }
  return made.sort();
}

async function ok(response, what) {
  if (response.ok) return response;
  const text = (await response.text()).slice(0, 500);
  throw new Error(`${what}: HTTP ${response.status}${text ? `: ${text}` : ''}`);
}

// The job's token for Artifact Keeper: Forgejo's for its audience, traded for Artifact Keeper's.
export async function signIn(env = process.env) {
  const id = await jobToken(audience, env);
  const response = await ok(await fetch(`${artifactKeeper}/api/v1/auth/ci/token`, {method: 'POST',
    headers: {Authorization: `Bearer ${id}`}, signal: AbortSignal.timeout(30000)}), 'signing in to Artifact Keeper with the job\'s token');
  return (await response.json()).access_token;
}

// Uploads one package. A version is published once: one already there with the same hash is
// this release's, from an earlier run of it; one with another hash is refused.
export async function uploadPackage({token, namespace, type, version, platform, data}) {
  const [os, arch] = platform.split('_');
  const response = await fetch(`${artifactKeeper}/terraform/${hostedRepository}/v1/providers/${namespace}/${type}/${version}/${os}/${arch}`, {
    method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip'}, body: data, signal: AbortSignal.timeout(300000)});
  if (response.status === 409) {
    const held = await (await ok(await fetch(`${mirror}${sourceHost}/${namespace}/${type}/${version}.json`, {signal: AbortSignal.timeout(30000)}), `reading ${type} ${version} from Artifact Keeper`)).json();
    if (held.archives?.[platform]?.hashes?.includes(`zh:${hash(data)}`)) return 'already published';
    throw new Error(`${sourceHost}/${namespace}/${type} ${version} for ${platform} is already published, and differs from this release's package`);
  }
  await ok(response, `uploading ${type} ${version} for ${platform}`);
  return 'published';
}

async function download(url, token) {
  const response = await ok(await fetch(url, {headers: {Authorization: `token ${token}`}, signal: AbortSignal.timeout(300000)}), `downloading ${new URL(url).pathname}`);
  return Buffer.from(await response.arrayBuffer());
}

// A published release's packages, to Artifact Keeper (release.mjs dispatch).
export async function publishProvider({tag = process.env.VERSION, repository, server = process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life',
  token = process.env.DISPATCH_TOKEN || process.env.TOKEN, env = process.env} = {}) {
  const type = providerType(repository), version = providerVersion(tag), namespace = repository.split('/')[0];
  if (!token) throw new Error('reading the release assets needs TOKEN or PIPELINE_DISPATCH_TOKEN');
  const release = await request(`${server}/api/v1/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {token});
  const assets = Object.fromEntries((release.assets || []).map(asset => [asset.name, asset]));
  const packages = providerPackages(Object.keys(assets), type, version);
  const akToken = await signIn(env);
  for (const [platform, file] of Object.entries(packages).sort()) {
    const result = await uploadPackage({token: akToken, namespace, type, version, platform, data: await download(assets[file].browser_download_url, token)});
    console.log(`${sourceHost}/${namespace}/${type} ${version} ${platform}: ${result}`);
  }
  return `${sourceHost}/${namespace}/${type}`;
}
