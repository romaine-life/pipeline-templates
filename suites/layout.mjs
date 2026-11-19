import fs from 'node:fs';
import TOML from '@iarna/toml';
import {safePath, tracked} from './lib.mjs';

// The settings a repository's files decide (PIPT-30): what its cluster service renders,
// where its image builds, which file pins the image, and which npm packages it tests. Read
// from the checkout the suite runs in; outside one, nothing is filled in.
const readFile = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

// k8s/ is a Helm chart (rendered with its values.yaml, and once more over each
// values-<case>.yaml beside it), a kustomization, or an Argo CD app of apps (root-app.yaml).
export function renders(files, name) {
  if (files.includes('k8s/Chart.yaml')) return [{kind: 'helm', path: 'k8s', name},
    ...files.filter(file => /^k8s\/values-[\w.-]+\.ya?ml$/.test(file)).sort().map(values => ({kind: 'helm', path: 'k8s', name, values}))];
  if (files.includes('k8s/kustomization.yaml')) return [{kind: 'kustomize', path: 'k8s'}];
  if (files.includes('k8s/root-app.yaml')) return [{kind: 'argocd', path: 'k8s/root-app.yaml'}];
  return [];
}

// An image builds from k8s/image/ when its Dockerfile is there, else from the root.
export const imageContext = files => files.includes('k8s/image/Dockerfile') ? 'k8s/image' : '.';

export const pinPattern = image => new RegExp(`${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[\\w.+-]+@sha256:[0-9a-f]{64}`);

// The one tracked YAML file that pins the image by digest; none when no file or several do.
export function pinFile(image, files, read = readFile) {
  const pattern = pinPattern(image);
  const found = files.filter(file => /\.ya?ml$/.test(file) && pattern.test(read(file) || ''));
  return found.length === 1 ? found[0] : undefined;
}

// Each package.json at the root or one directory down that has a test script.
export function packages(files, read = readFile) {
  return files.filter(file => /^(?:[^/]+\/)?package\.json$/.test(file)).sort()
    .filter(file => { try { return Boolean(JSON.parse(read(file)).scripts?.test); } catch { return false; } })
    .map(file => file === 'package.json' ? '.' : file.slice(0, -'/package.json'.length));
}

// What a release downloads and packs beside its build (shows' libmpv): the repository's
// release/dependencies.json, a list of {url, sha256 or lock, destination}, each from Artifact
// Keeper or Forgejo; extract takes one file out of a downloaded archive (PIPT-32).
export const downloadsFile = 'release/dependencies.json';
export function downloads(text, toolchains = []) {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error(`${downloadsFile} must be a list`);
  for (const dependency of value) {
    if(Object.keys(dependency).some(k=>!['toolchain','targets','url','sha256','lock','destination','extract'].includes(k)))throw new Error('unknown release dependency field');
    if(dependency.extract!==undefined)safePath(dependency.extract);
    if(dependency.toolchain && !toolchains.includes(dependency.toolchain))throw new Error('dependency toolchain is not declared');
    safePath(dependency.destination);
    if(dependency.targets && (!Array.isArray(dependency.targets) || !dependency.targets.length || new Set(dependency.targets).size!==dependency.targets.length || dependency.targets.some(t=>!/^[-\w]+$/.test(t))))throw new Error('dependency.targets must be unique target names');
    if (dependency.lock) safePath(dependency.lock);
    if (!dependency.lock && !/^[0-9a-f]{64}$/.test(dependency.sha256 || '')) throw new Error('release dependency needs a lock file or sha256');
    const url=new URL(dependency.url.replace('{tag}','version'));
    if (url.protocol!=='https:' || !['artifacts.home.romaine.life','forgejo.romaine.life'].includes(url.hostname)) throw new Error('release dependencies come from Artifact Keeper or Forgejo');
  }
  return value;
}

// A Rust release target's values, in the root Cargo.toml's
// [workspace.metadata.pipeline-templates.targets.<target>] (a single package's under
// [package.metadata...]): package, features, noDefaultFeatures and glibc. Its rust-build- topic
// builds the target (topics.mjs).
export function rustTargets(targets, text) {
  const manifest = text ? TOML.parse(text) : {};
  const key = 'pipeline-templates';
  const values = (manifest.workspace?.metadata?.[key] ?? manifest.package?.metadata?.[key])?.targets || {};
  for (const target of Object.keys(values)) if (!targets.some(part => part.target === target)) throw new Error(`Cargo.toml has release values for ${target}, which no rust-build- topic builds`);
  return targets.map(({target}) => {
    const part = {target, ...values[target]};
    if (Object.keys(part).some(field => !['target', 'package', 'features', 'noDefaultFeatures', 'glibc'].includes(field))) throw new Error(`Cargo.toml's ${target} values take package, features, noDefaultFeatures and glibc`);
    // A workspace that ships a different program per platform names its package: Cargo builds it
    // alone, with that package's own default features, instead of unifying every member's.
    if (part.package !== undefined && (typeof part.package !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part.package))) throw new Error(`Cargo.toml's ${target} package is a Cargo package name`);
    if (part.features !== undefined && (!Array.isArray(part.features) || part.features.some(feature => typeof feature !== 'string'))) throw new Error(`Cargo.toml's ${target} features are a list of feature names`);
    if (part.noDefaultFeatures !== undefined && typeof part.noDefaultFeatures !== 'boolean') throw new Error(`Cargo.toml's ${target} noDefaultFeatures is true or false`);
    if (part.glibc !== undefined && (!target.endsWith('-unknown-linux-gnu') || !/^2\.\d+$/.test(part.glibc))) throw new Error(`Cargo.toml's ${target} glibc is a 2.N floor, for a -unknown-linux-gnu target`);
    // The Linux runner is x86_64: another architecture links through zig, which a glibc floor selects.
    if (target.endsWith('-unknown-linux-gnu') && !target.startsWith('x86_64-') && part.glibc === undefined) throw new Error(`${target} builds through zig: give it a glibc floor in Cargo.toml`);
    return part;
  });
}

export function layout(cfg, repo, {files, read = readFile} = {}) {
  if (cfg.release?.rustTargets) cfg.release.rustTargets = rustTargets(cfg.release.rustTargets, read('Cargo.toml'));
  if (cfg.suites?.includes('release')) {
    const text = read(downloadsFile);
    if (text) cfg.release = {...cfg.release, dependencies: downloads(text, cfg.release?.toolchains)};
  }
  const cluster = cfg.suites?.includes('cluster-service'), npm = cfg.suites?.includes('web-app') || cfg.release?.toolchains?.includes('npm');
  if (!cluster && !cfg.cluster?.image && !cfg.web?.image && !npm) return cfg;
  if (!files) {
    try { files = tracked(); } catch { return cfg; }
  }
  const name = repo.split('/')[1];
  if (cluster) cfg.cluster = {...cfg.cluster, renders: renders(files, name)};
  if (cfg.cluster?.image) Object.assign(cfg.cluster, {context: imageContext(files), pinFile: pinFile(cfg.cluster.image, files, read)});
  if (cfg.web?.image) cfg.web.pinFile = pinFile(cfg.web.image, files, read);
  if (npm) {
    const found = packages(files, read);
    if (found.length) cfg.web = {...cfg.web, packages: found};
  }
  return cfg;
}

// The work package a pin PR links: the one the PR its release merged links.
export const workPackage = text => (text || '').match(/https:\/\/openproject\.home\.romaine\.life\/wp\/[A-Z][A-Z0-9]*-\d+/)?.[0];
