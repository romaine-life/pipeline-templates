import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {unzipSync} from 'fflate';
import {agbVersion, gbaFolders, romTitle} from '../rust/gba.mjs';
import {packageAssets} from '../release/assets.mjs';
import {releasePlan} from '../release/plan.mjs';
import {resolve} from '../topics.mjs';

const gbaConfig = '[unstable]\nbuild-std = ["core", "alloc"]\n\n[build]\ntarget = "thumbv4t-none-eabi"\n\n[target.thumbv4t-none-eabi]\nrustflags = ["-Clink-arg=-Tgba.ld"]\n';

test('rust-build-gba builds the GBA target, whose standard library the build makes rather than rustup', () => {
  const cfg = resolve({suites: ['rust', 'release']}, ['release-rust', 'rust-build-gba', 'home-sync'], 'romaine-life/power-lines-gba');
  assert.deepEqual(cfg.release.rustTargets, [{target: 'thumbv4t-none-eabi'}]);
  const [part] = releasePlan(cfg).matrix.include;
  assert.deepEqual(part, {id: 'rust-thumbv4t-none-eabi', toolchain: 'rust', target: 'thumbv4t-none-eabi', installTarget: '', features: '', noDefault: false, runner: 'ubuntu-latest'});
  const windows = releasePlan({release: {toolchains: ['rust'], rustTargets: [{target: 'x86_64-pc-windows-msvc'}]}}).matrix.include[0];
  assert.equal(windows.installTarget, 'x86_64-pc-windows-msvc', 'every other target installs its standard library through rustup');
});

test("a GBA crate is the folder whose .cargo/config.toml builds for the GBA, as agb's template has it", () => {
  const files = {
    'game/.cargo/config.toml': gbaConfig,
    '.cargo/config.toml': '[net]\ngit-fetch-with-cli = true\n',
    'tools/shot/.cargo/config.toml': '[target.thumbv4t-none-eabi]\nrunner = "mgba"\n',
    'other/.cargo/config.toml': 'not toml [',
    'game/src/main.rs': '',
  };
  const read = file => files[file];
  assert.deepEqual(gbaFolders(Object.keys(files), read), ['game'], 'only a build target makes the folder a GBA crate');
  assert.deepEqual(gbaFolders(['.cargo/config.toml'], () => gbaConfig), ['.'], 'the root can be the crate');
  assert.deepEqual(gbaFolders(['README.md'], read), []);
  assert.throws(() => gbaFolders(['bad/.cargo/config.toml'], () => 'target = "thumbv4t-none-eabi" ['), /bad\/\.cargo\/config\.toml/);
});

test("agb-gbafix matches the crate's agb, and the ROM's title is its program's name in capitals", () => {
  const lock = agb => `version = 4\n${agb.map(version => `\n[[package]]\nname = "agb"\nversion = "${version}"\n`).join('')}\n[[package]]\nname = "power-lines"\nversion = "0.1.0"\n`;
  assert.equal(agbVersion(lock(['0.25.0'])), '0.25.0');
  assert.throws(() => agbVersion(lock([])), /holds none/);
  assert.throws(() => agbVersion(lock(['0.24.0', '0.25.0'])), /0\.24\.0, 0\.25\.0/);
  assert.equal(romTitle('power-lines'), 'POWER LINES');
  assert.equal(romTitle('a_very-long_game_name'), 'A VERY LONG', 'at most the header\'s 12 bytes');
});

test("a GBA part publishes its ROM and its release assets as one ZIP named for the ROM", () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'gba-assets-'));
  try {
    process.chdir(root);
    fs.mkdirSync('dist');
    fs.writeFileSync('dist/power-lines.gba', 'rom');
    fs.writeFileSync('dist/strings.lua', 'bridge');
    packageAssets({kind: 'rust', target: 'thumbv4t-none-eabi'});
    assert.deepEqual(fs.readdirSync('dist'), ['power-lines.zip']);
    const entries = unzipSync(fs.readFileSync('dist/power-lines.zip'));
    assert.deepEqual(Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, Buffer.from(data).toString()])), {'power-lines.gba': 'rom', 'strings.lua': 'bridge'});
    fs.rmSync('dist', {recursive: true});
    fs.mkdirSync('dist');
    fs.writeFileSync('dist/a.gba', 'rom');
    fs.writeFileSync('dist/b.gba', 'rom');
    assert.throws(() => packageAssets({kind: 'rust', target: 'thumbv4t-none-eabi'}), /one ROM; its build left 2/);
  } finally { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); }
});
