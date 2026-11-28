import {api, hash, request} from '../lib.mjs';

// What stage() (release.mjs) records in a release's body: `Built from <sha>.` and then
// {sha, files: [{name, size, sha256}]}.
export function recorded(body) {
  const json = (body || '').slice((body || '').indexOf('\n\n') + 2);
  try { const record = JSON.parse(json); return record && typeof record.sha === 'string' && Array.isArray(record.files) ? record : null; } catch { return null; }
}

async function fetchAsset(url, token) {
  const response = await fetch(url, {headers: {Authorization: `token ${token}`}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The images a release of this version already published names, in its image.txt (one pin a
// line, the repository's own image first, then each other one: layout.mjs, images), as its bytes
// and as the pins they hold. A rerun of a release's publish, or a dispatch on the commit it was
// cut from, finds its version already out: its images are the ones to deliver, not a new build,
// which would push a different digest over the version's tag (AVATARS-6). Null when the version
// has no release yet or only a draft, which this run builds and stages. A published release
// from another commit, or one that records anything but its image.txt, is immutable and
// differs from this build: that fails here, before anything is built or pushed.
export async function publishedImage({images, tag = process.env.VERSION, sha = process.env.GITHUB_SHA, url = api(), token = process.env.TOKEN,
  downloadToken = process.env.DOWNLOAD_TOKEN, get = request, download = fetchAsset}) {
  const release = await get(`${url}/releases/tags/${encodeURIComponent(tag)}`, {token, allow404: true});
  if (!release || release.draft) return null;
  const record = recorded(release.body);
  if (record?.sha !== sha) throw new Error(`published release ${tag} is immutable and was built from ${record?.sha || 'another commit'}, not ${sha}`);
  const file = record.files.length === 1 && record.files[0].name === 'image.txt' ? record.files[0] : null;
  const asset = file && release.assets?.find(a => a.name === file.name && a.size === file.size);
  if (!asset) throw new Error(`published release ${tag} is immutable and holds no image.txt alone`);
  if (new URL(asset.browser_download_url).origin !== new URL(url).origin) throw new Error(`release ${tag}'s image.txt must download from its Forgejo`);
  // Forgejo answers its web download route with 404 for a job's own token (release/protocol.mjs).
  if (!downloadToken) throw new Error('reading a published release needs DOWNLOAD_TOKEN (actions/forgejo-token)');
  const bytes = await download(asset.browser_download_url, downloadToken);
  if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error(`release ${tag}'s image.txt differs from what the release records`);
  const pins = bytes.toString('utf8').trim().split(/\r?\n/);
  if (pins.length !== images.length || pins.some((pin, index) => !pin.startsWith(`${images[index]}:${tag}@`) || !/@sha256:[0-9a-f]{64}$/.test(pin))) {
    throw new Error(`release ${tag}'s image.txt names ${pins.join(', ')}, not ${images.map(image => `${image}:${tag}`).join(', ')} by digest`);
  }
  return {pins, bytes};
}
