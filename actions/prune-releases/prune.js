'use strict';

const KEEP = 10;

async function prune({api, token, fetch = globalThis.fetch, log = console.log}) {
  if (!token) throw new Error('missing release token');
  const headers = {Authorization: `token ${token}`};
  const call = async (method, path) => {
    const response = await fetch(`${api}${path}`, {method, headers, signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response;
  };

  const releases = [];
  for (let page = 1, total = Infinity; releases.length < total; page++) {
    const response = await call('GET', `/releases?draft=false&limit=50&page=${page}`);
    total = Number(response.headers.get('x-total-count'));
    const batch = await response.json();
    if (!batch.length) break;
    releases.push(...batch);
  }
  const published = releases.filter(r => !r.draft).sort((a, b) => b.id - a.id);
  const kept = new Set(published.slice(0, KEEP));
  const stable = published.find(r => !r.prerelease);
  if (stable) kept.add(stable);

  let files = 0, bytes = 0;
  for (const release of published) {
    if (kept.has(release)) continue;
    for (const asset of release.assets ?? []) {
      await call('DELETE', `/releases/${release.id}/assets/${asset.id}`);
      files++;
      bytes += asset.size;
    }
  }
  log(`Kept the files of ${kept.size} of ${published.length} releases; deleted ${files} older files (${(bytes / 1e6).toFixed(1)} MB)`);
  return {files, bytes};
}

module.exports = {prune, KEEP};

if (require.main === module) {
  const {GITHUB_SERVER_URL, INPUT_REPOSITORY, INPUT_TOKEN} = process.env;
  prune({api: `${GITHUB_SERVER_URL}/api/v1/repos/${INPUT_REPOSITORY}`, token: INPUT_TOKEN})
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
