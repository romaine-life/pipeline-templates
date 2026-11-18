import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {run, templates, kept, safePath} from '../lib.mjs';
import {config, currentRepository} from '../config.mjs';
import {tool} from '../tools.mjs';

const documents = file => YAML.parseAllDocuments(fs.readFileSync(file, 'utf8')).map(d => d.toJS()).filter(Boolean);
const owns = (url, repository) => {
  const {hostname, pathname} = new URL(url);
  return hostname === 'forgejo.romaine.life' && pathname.replace(/\.git$/, '').replace(/^\//, '') === repository;
};

// An Argo CD app of apps (`kind: argocd`, `path`: its root Application): the root and every
// Application in the directory it runs, and each of those whose source is this repository,
// rendered as Argo CD renders it: a chart by `helm template` with the app's name, namespace and
// CRD setting, anything else by `kustomize build --enable-helm`.
export function argoPlan(root, repository = currentRepository()) {
  safePath(root);
  const [app] = documents(root);
  if (app?.kind !== 'Application' || !app.spec?.source?.path) throw new Error(`${root} is not an Argo CD Application with a source path`);
  const dir = safePath(app.spec.source.path);
  const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => `${dir}/${f}`);
  const renders = [];
  for (const file of files) for (const doc of documents(file)) {
    if (doc.kind !== 'Application') continue;
    const source = doc.spec?.source;
    if (!source) throw new Error(`${file}: Application ${doc.metadata?.name} has no single source`);
    if (!owns(source.repoURL, repository)) continue;
    const sourcePath = safePath(source.path);
    const helm = source.helm || {};
    if (Object.keys(helm).some(k => k !== 'skipCrds')) throw new Error(`${file}: only helm.skipCrds is rendered as Argo CD would`);
    const name = doc.metadata.name, namespace = doc.spec.destination?.namespace;
    if (fs.existsSync(path.join(sourcePath, 'Chart.yaml'))) {
      renders.push({name, tool: 'helm', args: ['template', name, sourcePath, ...(namespace ? ['--namespace', namespace] : []), helm.skipCrds ? '--skip-crds' : '--include-crds']});
    } else {
      renders.push({name, tool: 'kustomize', args: ['build', '--enable-helm', sourcePath]});
    }
  }
  return {files: [root, ...files], renders};
}

async function kubeconform(files, {ignoreMissing = false} = {}) {
  run(await tool('kubeconform'), ['-strict', '-summary', ...(ignoreMissing ? ['-ignore-missing-schemas'] : []), '-cache', kept('kubeconform-schemas'),
    '-schema-location', 'https://artifacts.home.romaine.life/general/githubusercontent/yannh/kubernetes-json-schema/master/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json',
    '-schema-location', 'https://artifacts.home.romaine.life/general/githubusercontent/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', ...files]);
}
// A render goes straight to its file: a platform chart's output is larger than a captured buffer.
function renderTo(executable, args, file) {
  const out = fs.openSync(file, 'w');
  try { run(executable, args, {stdio: ['ignore', out, 'inherit']}); } finally { fs.closeSync(out); }
}
const digests = file => run('python3', [path.join(templates, 'actions/check-image-digests/check.py'), file]);

export async function main() {
  const renders = config().cluster?.renders || [];
  if (!renders.length) throw new Error('k8s/ holds no Chart.yaml, kustomization.yaml or Argo CD root-app.yaml to render');
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'manifests-'));
  try {
    for (const [index, render] of renders.entries()) {
      if (render.kind === 'argocd') {
        const plan = argoPlan(render.path);
        await kubeconform(plan.files);
        const helm = await tool('helm');
        const dir = path.join(temp, `${index}`);
        fs.mkdirSync(dir);
        for (const app of plan.renders) {
          const file = path.join(dir, `${app.name}.yaml`);
          const args = app.tool === 'kustomize' ? [...app.args, '--helm-command', helm] : app.args;
          console.log(`== ${app.name}: ${app.tool} ${app.args.join(' ')}`);
          renderTo(app.tool === 'helm' ? helm : await tool('kustomize'), args, file);
          // A platform app's own resource types have no published schema to check against.
          await kubeconform([file], {ignoreMissing: true});
        }
        // Over the apps together: one that runs no image (only storage or RBAC) is fine.
        digests(dir);
        continue;
      }
      const executable = await tool(render.kind);
      const args = render.kind === 'helm' ? ['template', render.name || 'app', render.path, ...(render.values ? ['-f', render.values] : [])] : ['build', render.path];
      const file = path.join(temp, `${index}.yaml`);
      renderTo(executable, args, file);
      await kubeconform([file]);
      digests(file);
    }
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
