// A broad check (a toolchain's tests, whether a merge cuts a release) reads the whole
// repository except `ignored`: documentation, the cluster manifests an image-pin PR changes
// (a pin must never cut a release, or releases loop) and infrastructure. The other checks
// read only the files their tool reads.
export const ignored = ['**/*.md', 'docs/**', 'LICENSE', 'LICENSE.*', 'LICENSE-*', 'COPYING', 'COPYING.*', 'NOTICE', 'NOTICE.*', 'k8s/**', 'tofu/**'];
const everything = ['**'];
export const inputs = {
  'default.fetches': ['.forgejo/workflows/**', '**/action.yml', '**/action.yaml', '**/Dockerfile*', '**/Containerfile*', '**/*.Dockerfile', '**/Cargo.toml', '**/Cargo.lock'],
  'default.rules': ['.forgejo/workflows/**', '.forgejo/actions/**', 'go.mod', '*.go', 'cmd/*/*.go', '.github/workflows/forgejo-sync.yml'],
  'go.format': ['**/*.go', 'go.mod'],
  'go.test': everything,
  'rust.format': ['**/*.rs', '**/Cargo.toml', 'rustfmt.toml', '.rustfmt.toml', 'rust-toolchain*'],
  'rust.typos': ['**/*.rs','**/*.md','**/*.toml','.typos.toml','rust-toolchain*'],
  'rust.machete': ['**/*.rs','**/Cargo.toml','**/Cargo.lock','rust-toolchain*','.cargo/**','**/.cargo/**'],
  'rust.audit': ['**/Cargo.lock','audit.toml','.cargo/audit.toml'],
  'cmake.test': everything,
  'dotnet.test': everything,
  'python.test': everything,
  'rust.test': everything,
  'cluster-service.manifests': ['k8s/**'],
  'cluster-service.image': ['Dockerfile', '.dockerignore', 'ci/smoke/**'],
  'web-app.test': everything,
  'web-app.image': ['Dockerfile', '.dockerignore', 'ci/smoke/**'],
  'tofu.plan': ['tofu/**'],
  'docs.validate': ['**/*.md'],
  'powershell.parse': ['**/*.ps1', '**/*.psm1', '**/*.psd1'],
  'powershell.files': ['**/*.json'],
  'release.build': everything,
  // On a PR the release builds only when what packages it changed; the tests cover the code.
  'release.package': ['.goreleaser.yaml','release/assets/**','ci/build/**','ci/package/**','scripts/build*','scripts/package*','packaging/**','installer/**','**/*.manifest','**/*.appxmanifest','**/*.syso','**/*.rc','**/*.ico','**/*.wxs','**/*.wxi','**/*.nsi','**/*.iss']
};
export const broad = Object.keys(inputs).filter(check => inputs[check] === everything);
// The web app's tests are a check per npm package (layout.mjs): one at the root reads the whole
// repository, one in a folder of its own reads that folder, the root's Node version
// (conventions.mjs) and the folders it references elsewhere (dependencies.mjs,
// packageReferences), all but their documentation, as the root's would.
export const packageInputs = (dir, references = []) => dir === '.' ? everything : [`${dir}/**`, '.nvmrc', '.node-version', ...references.map(name => `${name}/**`)];
// Tests, .gitignore and the repository's workflows (which call the suites, which build it)
// can't change a shipped binary, so a merge that changes only those cuts no release. A
// workflow that builds a release part itself counts (releaseInputs).
const unshipped = ['**/*_test.go', '**/testdata/**', 'tests/**', 'test/**', '**/tests/**', 'Tests/**', '**/Tests/**', 'benches/**', '**/*.test.*', '**/*.spec.*', '**/.gitignore', '.forgejo/workflows/**'];
export const ignoredBy = job => !broad.includes(job) ? [] : job === 'release.build' ? [...ignored, ...unshipped] : ignored;
export function matches(file, glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === '**/') { pattern += '(?:.*/)?'; i += 2; }
    else if (glob.slice(i, i + 2) === '**') { pattern += '.*'; i++; }
    else if (glob[i] === '*') pattern += '[^/]*';
    else if (glob[i] === '?') pattern += '[^/]';
    else pattern += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`).test(file);
}
// Whether a file is an input to a check: one its patterns name, outside `ignored` for a broad
// check, or one of `found`, the inputs read from the repository (a Go embed, a linked doc, a
// Dockerfile's COPY source, a render path), which count wherever they are. `own` stands for the
// check's patterns where its variant reads less (an npm package's folder, packageInputs).
export function input(file, job, found = [], own = inputs[job]) {
  if (!inputs[job]) throw new Error(`unknown check: ${job}`);
  if (found.some(p => matches(file, p))) return true;
  return own.some(p => matches(file, p)) && !ignoredBy(job).some(p => matches(file, p));
}
export function relevant(files, job, found = [], own = inputs[job]) {
  if (!inputs[job]) throw new Error(`unknown check: ${job}`);
  return files.some(file => input(file, job, found, own));
}
