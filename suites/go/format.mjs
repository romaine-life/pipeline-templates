import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../lib.mjs';
// A Windows checkout (core.autocrlf) has CRLF line endings its commit doesn't, so gofmt
// reads such a file as Git stores it: a copy with LF endings. A file committed with CRLF
// is read as it is, and fails.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gofmt-'));
try {
  const files = capture('git', ['ls-files', '--eol', '-z']).split('\0').filter(Boolean).flatMap(line => {
    const [eol, file] = line.split('\t');
    if (!file.endsWith('.go')) return [];
    if (!/^i\/lf\s+w\/crlf\b/.test(eol)) return [{file, path: file}];
    const copy = path.join(temp, file);
    fs.mkdirSync(path.dirname(copy), {recursive: true});
    fs.writeFileSync(copy, fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    return [{file, path: copy}];
  });
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const bad = capture('gofmt', ['-l', ...batch.map(f => f.path)]).split(/\r?\n/).filter(Boolean);
    if (bad.length) throw new Error(`gofmt: ${bad.map(p => batch.find(f => path.resolve(f.path) === path.resolve(p))?.file || p).join(' ')}`);
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
