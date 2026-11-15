import {run} from '../lib.mjs';
import {config} from '../config.mjs';
for (const cwd of config().web?.packages || ['.']) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {cwd, shell: process.platform === 'win32'});
  run(npm, ['run', 'lint'], {cwd, shell: process.platform === 'win32'});
  run(npm, ['test'], {cwd, shell: process.platform === 'win32', env: {...process.env, CI: 'true'}});
}
