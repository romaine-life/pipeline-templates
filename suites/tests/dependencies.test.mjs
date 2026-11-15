import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dockerSources, embedded, docLinks, localLinks} from '../dependencies.mjs';
test('image inputs come from named COPY sources, excluding prior build stages', () => {
  assert.deepEqual(dockerSources('FROM scratch\nCOPY go.mod go.sum ./\nCOPY ["internal", "internal"]\nCOPY --from=builder /app /app'), ['go.mod','go.mod/**','go.sum','go.sum/**','internal','internal/**']);
  for (const source of ['.', './', '${SOURCE}', 'https://example.invalid/archive']) assert.throws(()=>dockerSources(`COPY ${source} /app`),/named local inputs/);
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
