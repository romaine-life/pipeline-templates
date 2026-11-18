// vcpkg's only download source (X_VCPKG_ASSET_SOURCES, vcpkg.mjs): fetches a port's source or
// a tool vcpkg asks for through Artifact Keeper's cache of its host, into the file vcpkg names.
// vcpkg checks the file's SHA512 itself. A host with no cache fails the build, naming it.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const cache = 'https://artifacts.home.romaine.life/general';
const hosts = [
  [/^https:\/\/github\.com\/(.+)$/, 'github'],
  [/^https:\/\/(?:mirror|repo)\.msys2\.org\/(.+)$/, 'msys2'],
  [/^https:\/\/www\.python\.org\/ftp\/python\/(.+)$/, 'python-downloads'],
];
export function through(url) {
  for (const [pattern, name] of hosts) {
    const match = url.match(pattern);
    if (match) return `${cache}/${name}/${match[1]}`;
  }
  throw new Error(`vcpkg asked for ${url}, and no Artifact Keeper cache serves its host: add one (artifact-keeper k8s/caches.txt) and a line in pipeline-templates' suites/cmake/vcpkg-fetch.mjs`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, destination] = process.argv.slice(2);
  const response = await fetch(through(url), {signal: AbortSignal.timeout(600000)});
  if (!response.ok) throw new Error(`${through(url)}: HTTP ${response.status}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
