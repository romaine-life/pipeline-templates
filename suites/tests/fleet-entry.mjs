import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests give their repository settings the way production does: as its entry in a fleet
// list, here a temporary one CI_FLEET names, outside the repository under test.
let current = {};
export function fleetEntry(settings = {}, repo = process.env.GITHUB_REPOSITORY || 'test/probe') {
  const {version, ...rest} = settings;
  current = {suites: [], ...rest};
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-')), 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({repos: {[repo]: current}}));
  process.env.CI_FLEET = file;
  process.env.GITHUB_REPOSITORY ??= repo;
  return file;
}
export const currentEntry = () => structuredClone(current);
