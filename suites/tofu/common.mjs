import path from 'node:path';
import {kept, run} from '../lib.mjs';
import {currentRepository} from '../config.mjs';
import {tofuBackend} from '../conventions.mjs';
export function tofu(args) { run('tofu', ['-chdir=tofu', ...args]); }
export function init() {
  process.env.TF_PLUGIN_CACHE_DIR = kept(`tofu-providers/${(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-')}`);
  const backend = tofuBackend(currentRepository());
  tofu(['init', '-input=false', '-lockfile=readonly', ...Object.entries(backend).map(([k, v]) => `-backend-config=${k}=${v}`)]);
}
