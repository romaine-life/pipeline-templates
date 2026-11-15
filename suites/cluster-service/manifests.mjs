import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {capture, run, templates, kept} from '../lib.mjs';
import {config} from '../config.mjs';
import {tool} from '../tools.mjs';
const renders = config().cluster?.renders || [{kind: 'kustomize', path: 'k8s'}];
if (!renders.length) throw new Error('cluster.renders must include the deployed manifests');
const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'manifests-'));
try {
  for (const [index, render] of renders.entries()) {
    const executable = await tool(render.kind);
    const args = render.kind === 'helm' ? ['template', render.name || 'app', render.path, ...(render.values ? ['-f', render.values] : [])] : ['build', render.path];
    const file = path.join(temp, `${index}.yaml`);
    fs.writeFileSync(file, capture(executable, args));
    run(await tool('kubeconform'), ['-strict', '-summary', '-cache', kept('kubeconform-schemas'),
      '-schema-location', 'https://artifacts.home.romaine.life/general/githubusercontent/yannh/kubernetes-json-schema/master/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json',
      '-schema-location', 'https://artifacts.home.romaine.life/general/githubusercontent/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', file]);
    run('python3', [path.join(templates, 'actions/check-image-digests/check.py'), file]);
  }
} finally { fs.rmSync(temp, {recursive: true, force: true}); }
