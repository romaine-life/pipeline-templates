import fs from 'node:fs';
import {tracked} from '../lib.mjs';
for (const file of tracked().filter(f => f.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}
