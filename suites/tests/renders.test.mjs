import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {argoPlan} from '../cluster-service/manifests.mjs';
import {clusterImages, layout, otherImageNames, renders} from '../layout.mjs';

const app = (name, repo, source, namespace) => `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${name}
  namespace: argocd
spec:
  source:
    repoURL: https://forgejo.romaine.life/${repo}.git
    targetRevision: main
    path: ${source.path}
${source.extra || ''}  destination:
    server: https://kubernetes.default.svc
${namespace ? `    namespace: ${namespace}\n` : ''}`;

test("an app of apps renders each of this repository's apps as Argo CD would", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argo-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    fs.mkdirSync('k8s/apps', {recursive: true});
    fs.mkdirSync('k8s/gateway', {recursive: true});
    fs.writeFileSync('k8s/gateway/Chart.yaml', 'name: gateway\n');
    fs.mkdirSync('k8s/cert-manager', {recursive: true});
    fs.writeFileSync('k8s/root-app.yaml', app('apps', 'owner/cluster', {path: 'k8s/apps'}));
    fs.writeFileSync('k8s/apps/gateway.yaml', app('gateway', 'owner/cluster', {path: 'k8s/gateway', extra: '    helm:\n      skipCrds: true\n'}, 'envoy-gateway-system'));
    fs.writeFileSync('k8s/apps/cert-manager.yaml', app('cert-manager', 'owner/cluster', {path: 'k8s/cert-manager'}, 'cert-manager'));
    fs.writeFileSync('k8s/apps/ntfy.yaml', app('ntfy', 'owner/ntfy', {path: 'k8s'}, 'ntfy'));
    const plan = argoPlan('k8s/root-app.yaml', 'owner/cluster');
    assert.deepEqual(plan.files, ['k8s/root-app.yaml', 'k8s/apps/cert-manager.yaml', 'k8s/apps/gateway.yaml', 'k8s/apps/ntfy.yaml']);
    assert.deepEqual(plan.renders, [
      {name: 'cert-manager', tool: 'kustomize', args: ['build', '--enable-helm', 'k8s/cert-manager']},
      {name: 'gateway', tool: 'helm', args: ['template', 'gateway', 'k8s/gateway', '--namespace', 'envoy-gateway-system', '--skip-crds']},
    ]);
    fs.writeFileSync('k8s/apps/gateway.yaml', app('gateway', 'owner/cluster', {path: 'k8s/gateway', extra: '    helm:\n      valueFiles: [x.yaml]\n'}, 'envoy-gateway-system'));
    assert.throws(() => argoPlan('k8s/root-app.yaml', 'owner/cluster'), /only helm.skipCrds/);
  } finally { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); }
});

test('k8s/ decides the renders: a chart and its values- cases, a kustomization, or an app of apps', () => {
  assert.deepEqual(renders(['k8s/Chart.yaml', 'k8s/values.yaml', 'k8s/values-unserved.yaml', 'k8s/templates/a.yaml', 'tests/values-x.yaml'], 'store'), [
    {kind: 'helm', path: 'k8s', name: 'store'}, {kind: 'helm', path: 'k8s', name: 'store', values: 'k8s/values-unserved.yaml'}]);
  assert.deepEqual(renders(['k8s/kustomization.yaml', 'k8s/deployment.yaml'], 'app'), [{kind: 'kustomize', path: 'k8s'}]);
  assert.deepEqual(renders(['k8s/root-app.yaml', 'k8s/apps/a.yaml'], 'cluster'), [{kind: 'argocd', path: 'k8s/root-app.yaml'}]);
  assert.deepEqual(renders(['nas/repo-sync/kustomization.yaml'], 'home'), []);
});
test("each k8s/image/<name>/Dockerfile is another image of the repository's, named <repo>-<name> and pinned where its pin is", () => {
  const files = ['Dockerfile', 'k8s/Chart.yaml', 'k8s/values.yaml', 'k8s/image/docker/Dockerfile', 'k8s/image/docker/daemon.json', 'k8s/image/README.md', 'k8s/image/Bad_Name/Dockerfile', 'k8s/image/a/b/Dockerfile'];
  assert.deepEqual(otherImageNames(files), ['docker']);
  const values = `runner:\n  image: forgejo.romaine.life/o/runner:v1.0.0@sha256:${'a'.repeat(64)}\n  docker: forgejo.romaine.life/o/runner-docker:v1.0.0@sha256:${'b'.repeat(64)}\n`;
  const read = file => file === 'k8s/values.yaml' ? values : null;
  const cfg = layout({suites: ['cluster-service'], cluster: {image: 'forgejo.romaine.life/o/runner'}}, 'o/runner', {files, read});
  assert.equal(cfg.cluster.context, '.');
  assert.equal(cfg.cluster.pinFile, 'k8s/values.yaml');
  assert.deepEqual(cfg.cluster.images, [{name: 'docker', image: 'forgejo.romaine.life/o/runner-docker', context: 'k8s/image/docker', pinFile: 'k8s/values.yaml'}]);
  assert.deepEqual(clusterImages(cfg.cluster).map(section => [section.image, section.context]), [['forgejo.romaine.life/o/runner', '.'], ['forgejo.romaine.life/o/runner-docker', 'k8s/image/docker']]);
  // Without cluster-image the service builds nothing, so no other image either.
  assert.equal(layout({suites: ['cluster-service'], cluster: {build: false, smoke: false}}, 'o/runner', {files, read}).cluster.images, undefined);
});
