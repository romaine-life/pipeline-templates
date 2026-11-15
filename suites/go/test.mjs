import {run} from '../lib.mjs';
import {goEnvironment} from './environment.mjs';
goEnvironment();
run('go', ['vet', '-p', '4', './...']);
run('go', ['test', '-p', '4', './...']);
