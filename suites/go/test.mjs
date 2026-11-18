import {capture, run} from '../lib.mjs';
import {config} from '../config.mjs';
import {goReleaserBuilds} from './goreleaser.mjs';
import {goEnvironment} from './environment.mjs';
goEnvironment();
// A js/wasm release target's code builds only for js/wasm, so it is vetted there as
// well; a module that is only that (fzt-browser) has no native packages to vet or test.
const wasm = goReleaserBuilds().some(b => b.targets.some(t => t.goos === 'js'));
const native = capture('go', ['list', './...']) !== '';
if (!native && !wasm) throw new Error('no Go packages build here, and no js/wasm release target names where they do');
if (native) {
  run('go', ['vet', '-p', '4', './...']);
  run('go', ['test', '-p', '4', './...']);
}
// With the go-race topic every package's tests run again under the race detector. It
// needs cgo, which the Linux runner has, so it runs there.
const race = config().go?.race || [];
if (race.length && process.platform === 'linux') run('go', ['test', '-race', '-p', '4', ...race], {env: {CGO_ENABLED: '1'}});
if (wasm) run('go', ['vet', '-p', '4', './...'], {env: {GOOS: 'js', GOARCH: 'wasm'}});
