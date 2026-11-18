// Proves a change to how fleet.json is read leaves every repository's CI as it was:
// for each entry, the settings the suites read at <base> (its suites, its fleet.json) and
// in this checkout (with the topics fleet.json gives the repository, as Fleet sets them),
// and what the suites derive from them: the checks and platforms each suite runs, the
// release plan, and the release packaging settings.
//
//   node suites/tests/equivalence.mjs <base commit>
//
// Two differences are by construction and are normalised, not hidden: a test platform
// list of Linux alone, written out or left to the default, and the order of a release's
// Rust targets, which only orders its build jobs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {capture, templates} from '../lib.mjs';
import {config, fleet, suiteNames} from '../config.mjs';
import {checkVariants} from '../fingerprints.mjs';
import {releasePlan} from '../release/plan.mjs';
import {testPlatforms} from '../inputs.mjs';
import {settings as packaging} from '../release/inputs.mjs';

const base = process.argv[2];
if (!base) throw new Error('equivalence.mjs <base commit>');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equivalence-'));
try {
  const sha = capture('git', ['-C', templates, 'rev-parse', '--verify', `${base}^{commit}`]);
  capture('git', ['-C', templates, 'archive', '--format=tar', '-o', path.join(dir, 'base.tar'), sha, 'fleet.json', 'suites']);
  capture('tar', ['-xf', 'base.tar'], {cwd: dir});
  fs.symlinkSync(path.join(templates, 'suites', 'node_modules'), path.join(dir, 'suites', 'node_modules'), 'junction');
  // The base's settings, from its own code in a process of their own.
  const script = `import {config, fleet} from ${JSON.stringify(pathToFileURL(path.join(dir, 'suites', 'config.mjs')).href)};
    const repos = fleet(${JSON.stringify(path.join(dir, 'fleet.json'))});
    console.log(JSON.stringify(Object.fromEntries(Object.keys(repos).map(repo => [repo, config(repo, repos, repos[repo].topics || [])]))));`;
  const old = JSON.parse(capture(process.execPath, ['--input-type=module', '-e', script], {cwd: dir}));
  const newRepos = fleet();
  assert.deepEqual(Object.keys(newRepos).sort(), Object.keys(old).sort(), 'the same repositories are listed');

  const normal = cfg => {
    const value = structuredClone(cfg);
    delete value.topics;
    for (const tool of ['go', 'rust', 'cmake', 'dotnet', 'python']) {
      if (JSON.stringify(value[tool]?.platforms) === '["ubuntu-latest"]') delete value[tool].platforms;
    }
    value.release?.rustTargets?.sort((a, b) => a.target.localeCompare(b.target));
    for (const [key, section] of Object.entries(value)) if (section && typeof section === 'object' && !Array.isArray(section) && !Object.keys(section).length) delete value[key];
    return value;
  };
  const derived = cfg => {
    const plan = (() => { try { return releasePlan(cfg); } catch (error) { return `throws: ${error.message}`; } })();
    if (plan.matrix) plan.matrix.include.sort((a, b) => a.id.localeCompare(b.id));
    return {
      checks: Object.fromEntries(suiteNames.map(suite => [suite, checkVariants(suite, cfg).map(check => check.key)])),
      platforms: Object.fromEntries(['go', 'rust', 'cmake', 'dotnet', 'python'].map(suite => [suite, testPlatforms(suite, cfg, () => true)])),
      plan: cfg.release ? plan : null,
      packaging: normal(packaging(cfg)),
    };
  };
  let same = 0;
  const differ = [];
  for (const repo of Object.keys(old).sort()) {
    const was = old[repo], now = config(repo, newRepos, newRepos[repo].topics || []);
    try {
      assert.deepEqual(normal(now), normal(was));
      assert.deepEqual(derived(now), derived(was));
      same++;
    } catch (error) { differ.push(`${repo}: ${error.message}`); }
  }
  console.log(`${same} of ${Object.keys(old).length} repositories run with the same settings at ${sha.slice(0, 12)} and here`);
  for (const line of differ) console.log(line);
  if (differ.length) process.exitCode = 1;
} finally { fs.rmSync(dir, {recursive: true, force: true}); }
