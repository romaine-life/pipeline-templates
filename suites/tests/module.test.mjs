import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from '../config.mjs';
import {releasePlan} from '../release/plan.mjs';

// A Go library releases its tag and source (release.module): nothing is built, so the
// asset protocol's matrix is empty and its build settings are refused.
test('release.module plans no build and refuses build settings', () => {
  const entry = {suites: ['go', 'release'], release: {module: true, prefix: 'v0.2'}};
  validate(entry, 'test/lib');
  const plan = releasePlan(entry);
  assert.deepEqual(plan.matrix.include, []);
  assert.equal(plan.local, false);
  for (const extra of [{toolchains: ['go']}, {goTargets: [{goos: 'linux', goarch: 'amd64'}]}, {assets: ['dist/x']}]) {
    assert.throws(() => validate({...entry, release: {...entry.release, ...extra}}, 'test/lib'), /builds nothing/);
  }
  assert.throws(() => validate({suites: ['release'], release: {module: 'yes'}}, 'test/lib'), /boolean/);
});
