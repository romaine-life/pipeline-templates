import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The suites check out into _ci/ inside the repository, so Node would take the actions' module
// type from the repository's own package.json (auth's says "module") without actions/package.json.
test("the actions stay CommonJS inside a repository whose package.json is ESM", () => {
  const actions = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'actions');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-repo-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    fs.cpSync(actions, path.join(root, '_ci', 'actions'), {recursive: true});
    for (const script of ['release-version/version.js', 'prune-releases/prune.js']) {
      // Run as the action runs it; its own argument checks may fail, its module type must not.
      const result = spawnSync(process.execPath, [path.join(root, '_ci', 'actions', script)], {cwd: root, encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: ''}});
      assert.doesNotMatch(result.stderr, /require is not defined|ERR_REQUIRE_ESM/, script);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
