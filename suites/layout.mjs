import fs from 'node:fs';
import {tracked} from './lib.mjs';

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

export function layout(cfg, repo, {files, read = readFile} = {}) {
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
