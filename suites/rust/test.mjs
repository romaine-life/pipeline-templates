import {run} from '../lib.mjs';
import {cargoCache} from './cache.mjs';
import {rustEnvironment} from './environment.mjs';
rustEnvironment();
cargoCache(`test-${process.platform}`);
const args = ['--locked', '--workspace'];
run('cargo', ['clippy', '-j', '4', ...args, '--all-targets', '--', '-D', 'warnings']);
run('cargo', ['test', '-j', '4', ...args]);
