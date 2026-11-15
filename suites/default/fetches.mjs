import path from 'node:path';
import {run, templates} from '../lib.mjs';
run(process.platform === 'win32' ? 'python' : 'python3', [path.join(templates, 'actions/check-fetches/check.py'), '.']);
