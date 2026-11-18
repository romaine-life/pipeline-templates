import fs from 'node:fs';
import path from 'node:path';
import {requiredDocs} from '../conventions.mjs';
import {tracked, run, capture} from '../lib.mjs';
import {localLinks} from '../dependencies.mjs';
for (const file of requiredDocs) {
  if (!fs.readFileSync(file, 'utf8').trim()) throw new Error(`empty required document: ${file}`);
}
const decoder = new TextDecoder('utf-8', {fatal: true});
for (const file of tracked().filter(f => f.endsWith('.md'))) {
  const text = decoder.decode(fs.readFileSync(file));
  for (const local of localLinks(file, text)) {
    if (!fs.existsSync(local)) throw new Error(`${file}: missing link ${local}`);
  }
}
const empty = capture('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], {input: '', stdio: ['pipe', 'pipe', 'inherit']});
run('git', ['diff', '--check', empty, 'HEAD', '--', '*.md']);
