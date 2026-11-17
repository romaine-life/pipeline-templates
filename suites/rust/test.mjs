import {run} from '../lib.mjs';
import {config} from '../config.mjs';
import {cargoCache} from './cache.mjs';
import {rustEnvironment} from './environment.mjs';
rustEnvironment();
cargoCache(`test-${process.platform}`);
const cfg = config().rust || {};
const features=cfg.platformFeatures?.[process.platform] || cfg.features;
const args = ['--locked', '--workspace', ...(cfg.noDefaultFeatures ? ['--no-default-features'] : []),
  ...(features?.length ? ['--features', features.join(',')] : [])];
run('cargo', ['clippy', '-j', '4', ...args, '--all-targets', '--', '-D', 'warnings']);
run('cargo', ['test', '-j', '4', ...args]);
