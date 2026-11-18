import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from '../config.mjs';
import {resolve} from '../topics.mjs';
import {checkVariants} from '../fingerprints.mjs';
import {matrixOutput, releasePlan} from '../release/plan.mjs';

// A Go library releases its tag and source (release-module): nothing is built, so the
// asset protocol's matrix is empty and its build settings are refused.
test('release-module plans no build and refuses build settings', () => {
  const entry = {suites: ['go', 'release'], topics: ['release-module']};
  validate(entry, 'test/lib');
  const plan = releasePlan(resolve(entry, entry.topics));
  assert.deepEqual(plan.matrix.include, []);
  assert.equal(plan.local, false);
  for (const [topics, extra] of [[['release-go'], {}], [[], {assets: ['dist/x']}]]) {
    assert.throws(() => validate({...entry, topics: [...entry.topics, ...topics], release: extra}, 'test/lib'), /builds nothing/);
  }
});

test('an empty plan reaches the workflow as one placeholder entry, so its jobs exist and skip', () => {
  const plan = releasePlan({suites: ['go', 'release'], release: {module: true}});
  assert.deepEqual(JSON.parse(matrixOutput(plan.matrix)), {include: [{toolchain: 'none', runner: 'ubuntu-latest'}]});
  const built = {include: [{toolchain: 'go', target: 'linux-amd64'}]};
  assert.deepEqual(JSON.parse(matrixOutput(built)), built);
});

test('a module may join its cluster image, and nothing else', () => {
  const entry = {suites: ['cluster-service', 'go', 'release'], topics: ['cluster-image', 'release-module'], release: {image: 'cluster'}};
  validate(entry, 'test/lib');
  assert.throws(() => validate({...entry, topics: [...entry.topics, 'web-image'], release: {image: 'web'}}, 'test/lib'), /at most its cluster image/);
});

test("a module's joined cluster image is a PR check, reuse included", () => {
  const module = {suites: ['cluster-service', 'release'], cluster: {image: 'forgejo.romaine.life/romaine-life/lib'}, release: {module: true, image: 'cluster'}};
  assert.ok(checkVariants('cluster-service', module).some(c => c.check === 'cluster-service.image'));
  const joined = {suites: ['cluster-service', 'release'], cluster: {image: 'forgejo.romaine.life/romaine-life/app'}, release: {toolchains: ['go'], image: 'cluster'}};
  assert.ok(!checkVariants('cluster-service', joined).some(c => c.check === 'cluster-service.image'));
});
