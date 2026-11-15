import path from 'node:path';
import {run,suites} from '../lib.mjs';
import {tool} from '../tools.mjs';
run(process.platform==='win32' ? 'pwsh' : await tool('pwsh'),['-NoProfile','-File',path.join(suites,'powershell/parse.ps1')]);
