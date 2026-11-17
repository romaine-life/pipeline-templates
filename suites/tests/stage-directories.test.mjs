import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stagedFiles} from '../release.mjs';

test("a directory staged for release goes out as one archive beside it; files go as they are", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  try {
    fs.mkdirSync(path.join(root, 'dist', 'frontend', 'assets'), {recursive: true});
    fs.writeFileSync(path.join(root, 'dist', 'frontend', 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(root, 'dist', 'frontend', 'assets', 'app.js'), 'run()');
    fs.writeFileSync(path.join(root, 'dist', 'tool.exe'), 'MZ');
    const files = stagedFiles([path.join(root, 'dist', 'frontend'), path.join(root, 'dist', 'tool.exe')]);
    assert.deepEqual(files, [path.join(root, 'dist', 'frontend.zip'), path.join(root, 'dist', 'tool.exe')]);
    const zip = fs.readFileSync(files[0]);
    assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(zip.includes('index.html') && zip.includes('assets/app.js'));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
