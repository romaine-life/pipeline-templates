import path from 'node:path';
import {pythonProjects} from '../conventions.mjs';
import {run} from '../lib.mjs';
import {pythonEnvironment} from './test.mjs';
for (const cwd of pythonProjects()) {
  pythonEnvironment(cwd);
  run('uv',['build','--out-dir',path.resolve('dist')],{cwd});
}
