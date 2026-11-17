import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {dockerSources, embedded, docLinks, localLinks, imageInputs} from '../dependencies.mjs';
import {joinedImageChanged} from '../release.mjs';
test('image inputs come from named COPY sources, excluding prior build stages', () => {
  assert.deepEqual(dockerSources('FROM scratch\nCOPY go.mod go.sum ./\nCOPY ["internal", "internal"]\nCOPY --from=builder /app /app'), ['go.mod','go.mod/**','go.sum','go.sum/**','internal','internal/**']);
  for (const source of ['.', './', '${SOURCE}', 'https://example.invalid/archive']) assert.throws(()=>dockerSources(`COPY ${source} /app`),/named local inputs/);
});
test('an image built from another context takes its inputs there', () => {
  const files = {'k8s/image/Dockerfile': 'FROM scratch\nCOPY run.sh stager.sh /\n', 'Dockerfile': 'FROM scratch\nCOPY src /src\n'};
  const read = file => files[file] ?? null;
  assert.deepEqual(imageInputs({context: 'k8s/image'}, read), ['k8s/image/Dockerfile', 'k8s/image/.dockerignore', 'ci/smoke/**', 'k8s/image/run.sh', 'k8s/image/run.sh/**', 'k8s/image/stager.sh', 'k8s/image/stager.sh/**']);
  assert.deepEqual(imageInputs({}, read), ['Dockerfile', '.dockerignore', 'ci/smoke/**', 'src', 'src/**']);
});
test('a joined image is built again only when its inputs changed since the pinned release', () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'joined-image-'));
  const git = (...args) => { const r = spawnSync('git', args, {cwd: root, encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text); };
  const commit = message => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message); };
  const section = {image: 'forgejo.romaine.life/o/session', context: 'k8s/image', pinFile: 'k8s/values.yaml'};
  const pin = tag => `image: ${section.image}:${tag}@sha256:${'a'.repeat(64)}\n`;
  try {
    git('init', '-q');
    write('k8s/image/Dockerfile', 'FROM scratch\nCOPY run.sh /\n'); write('k8s/image/run.sh', 'one'); write('k8s/values.yaml', pin('v1.0.1')); write('src/main.rs', 'one');
    commit('first'); git('tag', 'v1.0.1');
    process.chdir(root);
    write('src/main.rs', 'two'); commit('code');
    assert.equal(joinedImageChanged(section), false, 'a code change keeps the pinned image');
    write('k8s/image/run.sh', 'two'); commit('image');
    assert.equal(joinedImageChanged(section), true, 'a file the Dockerfile copies builds a new image');
    write('k8s/values.yaml', pin('v9.9.9')); commit('unknown');
    assert.equal(joinedImageChanged(section), true, 'a pin naming no tag here builds a new image');
  } finally { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); }
});
test('Markdown reference links, parentheses and code examples parse correctly', () => {
  assert.deepEqual(localLinks('docs/guide.md','[a][ref]\n\n[ref]: <file (1).md>\n\n![b](image.png)\n\n`[sample](missing.md)`'),['docs/file (1).md','docs/image.png']);
});
test('embedded assets and linked local files are dependencies, including missing targets', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dependencies-'));
  const go=path.join(root,'main.go'), rust=path.join(root,'main.rs'), doc=path.join(root,'README.md');
  try {
    fs.writeFileSync(go,'//go:embed assets/* "file name.txt"\n');
    fs.writeFileSync(rust,'let text=include_str!("missing.txt");');
    fs.writeFileSync(doc,'[image](missing.png) [remote](https://example.invalid)');
    assert.ok(embedded([go,rust]).go.some(p=>p.endsWith('assets/*')));
    assert.ok(embedded([go,rust]).rust.some(p=>p.endsWith('missing.txt')));
    assert.ok(docLinks([doc]).some(p=>p.endsWith('missing.png')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
