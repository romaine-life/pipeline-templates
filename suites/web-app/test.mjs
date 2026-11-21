import {run} from '../lib.mjs';
import {config} from '../config.mjs';
// One npm package's lint and tests (TEST_PACKAGE, its folder: check-test's matrix runs each
// package whose inputs changed), or every package's.
const packages = config().web?.packages || ['.'];
const only = process.env.TEST_PACKAGE;
if (only && !packages.includes(only)) throw new Error(`${only} is not one of the web app's npm packages: ${packages.join(', ')}`);
for (const cwd of only ? [only] : packages) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {cwd, shell: process.platform === 'win32'});
  run(npm, ['run', 'lint'], {cwd, shell: process.platform === 'win32'});
  run(npm, ['test'], {cwd, shell: process.platform === 'win32', env: {...process.env, CI: 'true'}});
}
