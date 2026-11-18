import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {argoPlan} from '../cluster-service/manifests.mjs';
import {validate} from '../config.mjs';

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

test('an argocd render names only its root Application', () => {
  validate({suites: ['cluster-service'], cluster: {renders: [{kind: 'argocd', path: 'k8s/root-app.yaml'}]}}, 'test/cluster');
  assert.throws(() => validate({suites: ['cluster-service'], cluster: {renders: [{kind: 'argocd', path: 'k8s/root-app.yaml', values: 'v.yaml'}]}}, 'test/cluster'), /root Application/);
});
