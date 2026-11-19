import path from 'node:path';
import {run} from '../lib.mjs';
import {configureBuild} from './test.mjs';
run('cmake',['--install',await configureBuild(),'--config','Release','--prefix',path.resolve('dist')]);
