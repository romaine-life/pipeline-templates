export const inputs = {
  'default.fetches': ['.forgejo/workflows/**', '**/action.yml', '**/action.yaml', '**/Dockerfile*', '**/Containerfile*', '**/*.Dockerfile', '**/Cargo.toml', '**/Cargo.lock'],
  'default.rules': ['.forgejo/workflows/**', '.forgejo/actions/**'],
  'go.format': ['**/*.go', 'go.mod'],
  'go.test': ['**/*.go', '**/go.mod', '**/go.sum', 'go.work', 'go.work.sum', '**/testdata/**'],
  'rust.format': ['**/*.rs', '**/Cargo.toml', 'rustfmt.toml', '.rustfmt.toml', 'rust-toolchain*'],
  'rust.typos': ['**/*.rs','**/*.md','**/*.toml','.typos.toml','rust-toolchain*'],
  'rust.machete': ['**/*.rs','**/Cargo.toml','**/Cargo.lock','rust-toolchain*','.cargo/**','**/.cargo/**'],
  'cmake.test': ['**/CMakeLists.txt', '**/*.cmake', 'CMakePresets.json', '**/*.c', '**/*.cc', '**/*.cpp', '**/*.h', '**/*.hpp', 'vcpkg.json', 'vcpkg-configuration.json', 'tests/**', 'test/**'],
  'dotnet.test': ['**/*.cs', '**/*.fs', '**/*.vb', '**/*.*proj', '**/*.sln', '**/*.slnx', 'global.json', '**/*.props', '**/*.targets', '**/packages.lock.json', 'NuGet.Config', '.editorconfig', 'tests/**', 'Tests/**'],
  'python.test': ['pyproject.toml', 'uv.lock', '.python-version', '**/*.py', '**/*.pyi', 'ruff.toml', '.ruff.toml', 'pytest.ini', 'conftest.py', 'src/**', 'tests/**'],
  'rust.test': ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock', '**/.cargo/**', '.cargo/**', '**/build.rs', 'rust-toolchain*', '**/tests/**', '**/benches/**'],
  'cluster-service.manifests': ['k8s/**'],
  'cluster-service.image': ['Dockerfile', '.dockerignore', 'ci/smoke/**'],
  'web-app.test': ['package*.json', '.npmrc', 'src/**', 'public/**', '*config.*', 'test/**', 'tests/**'],
  'web-app.image': ['Dockerfile', '.dockerignore', 'ci/smoke/**'],
  'tofu.plan': ['tofu/**'],
  'docs.validate': ['**/*.md'],
  'powershell.parse': ['**/*.ps1', '**/*.psm1', '**/*.psd1'],
  'powershell.files': ['**/*.json'],
  'release.build': ['commands/**','Dockerfile','.dockerignore','ci/smoke/**','cmd/**', 'internal/**', 'pkg/**', '**/*.go', 'go.mod', 'go.sum', '**/*.rs', '**/Cargo.toml', 'Cargo.lock', '.cargo/**', 'rust-toolchain*', 'assets/**', 'package*.json', 'src/**', 'frontend/**', 'backend/**', '**/*.cs', '**/*.*proj', '**/*.props', '**/*.targets', '**/*.sln*', 'global.json', '**/packages.lock.json', '**/*.py', '**/pyproject.toml', '**/uv.lock', '**/CMakeLists.txt', '**/*.cmake', '**/*.cpp', '**/*.c', '**/*.h', 'CMakePresets.json']
  ,'release.package': ['release/assets/**','ci/build/**','ci/package/**','scripts/build*','scripts/package*','packaging/**','installer/**','**/*.manifest','**/*.appxmanifest','**/*.syso','**/*.rc','**/*.ico','**/*.wxs','**/*.wxi','**/*.nsi','**/*.iss']
};
inputs['release.build'].push(...inputs['release.package']);
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
export function relevant(files, job, cfg) {
  if (!inputs[job]) throw new Error(`unknown check: ${job}`);
  let standard = inputs[job];
  const image=job==='cluster-service.image'?cfg.cluster:job==='web-app.image'?cfg.web:job==='release.build' && cfg.release?.image?cfg[cfg.release.image]:null;
  if(image)standard=standard.filter(pattern=>!(pattern==='Dockerfile' && image.dockerfile && image.dockerfile!=='Dockerfile') && !(pattern==='.dockerignore' && image.context && image.context!=='.'));
  if (job === 'web-app.test') standard = (cfg.web?.packages || ['.']).flatMap(pkg => inputs[job].map(p => pkg === '.' ? p : `${pkg}/${p}`));
  const patterns = [...standard, ...(cfg.inputs?.[job] || []), ...(job==='release.package' ? [] : ['.ci.json'])];
  return files.some(f => patterns.some(p => matches(f, p)));
}
