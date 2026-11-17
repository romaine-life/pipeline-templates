import fs from 'node:fs';
import {changed, matches} from '../inputs.mjs';
import {output} from '../lib.mjs';
const groups=JSON.parse(fs.readFileSync(new URL('./ci-inputs.json',import.meta.url),'utf8'));
const files=changed();
for (const [key,patterns] of Object.entries(groups)) output(key,files.some(file=>['.forgejo/workflows/ci.yml','suites/tests/ci-inputs.json',...patterns].some(p=>matches(file,p))));
