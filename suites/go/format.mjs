import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture, tracked} from '../lib.mjs';
// A Windows checkout (core.autocrlf) has CRLF line endings the commit won't, so gofmt reads
// each such file as Git stores it: a copy with LF endings.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gofmt-'));
try {
  const files = tracked().filter(f => f.endsWith('.go')).map(file => {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('\r\n')) return {file, path: file};
    const copy = path.join(temp, file);
    fs.mkdirSync(path.dirname(copy), {recursive: true});
    fs.writeFileSync(copy, text.replaceAll('\r\n', '\n'));
    return {file, path: copy};
  });
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const bad = capture('gofmt', ['-l', ...batch.map(f => f.path)]).split(/\r?\n/).filter(Boolean);
    if (bad.length) throw new Error(`gofmt: ${bad.map(p => batch.find(f => path.resolve(f.path) === path.resolve(p))?.file || p).join(' ')}`);
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
