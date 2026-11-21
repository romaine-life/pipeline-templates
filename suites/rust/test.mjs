import {run} from '../lib.mjs';
import {cargoCache} from './cache.mjs';
import {rustEnvironment} from './environment.mjs';
import {gbaFolders} from './gba.mjs';
rustEnvironment();
cargoCache(`test-${process.platform}`);
const args = ['--locked', '--workspace'];
const gba = gbaFolders();
if (!gba.includes('.')) {
  run('cargo', ['clippy', '-j', '4', ...args, '--all-targets', '--', '-D', 'warnings']);
  run('cargo', ['test', '-j', '4', ...args]);
}
// A GBA crate (gba.mjs) is linted in its own folder, for the GBA, as its release builds it; its
// programs run only on the console, so there are no host tests to run.
for (const folder of gba) run('cargo', ['clippy', '-j', '4', ...args, '--release', '--', '-D', 'warnings'], {cwd: folder});
