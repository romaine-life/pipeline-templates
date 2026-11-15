import fs from 'node:fs';
import path from 'node:path';
import {run, suites} from '../lib.mjs';
import {tool} from '../tools.mjs';
const files = fs.readdirSync(suites,{withFileTypes:true}).filter(d=>d.isDirectory() && !['node_modules','tests'].includes(d.name))
  .flatMap(d=>fs.readdirSync(path.join(suites,d.name)).filter(f=>/\.ya?ml$/.test(f)).map(f=>path.join(suites,d.name,f)));
if (process.argv.includes('--own')) files.push(...fs.readdirSync('.forgejo/workflows').filter(f=>/\.ya?ml$/.test(f)).map(f=>`.forgejo/workflows/${f}`));
run(await tool('actionlint'),['-ignore','unexpected key "enable-openid-connect"','-ignore','unexpected key "cmd" for "services" section',...files]);
