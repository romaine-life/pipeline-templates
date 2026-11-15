import path from 'node:path';
import {config} from '../config.mjs';
import {run} from '../lib.mjs';
import {pythonEnvironment} from './test.mjs';
for (const cwd of config().python?.projects || ['.']) {
  pythonEnvironment(cwd);
  run('uv',['build','--out-dir',path.resolve('dist')],{cwd});
}
