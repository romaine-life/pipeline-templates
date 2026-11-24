import fs from 'node:fs';
import path from 'node:path';
import {kept, hash, run} from './lib.mjs';

const mirror = 'https://artifacts.home.romaine.life/general';
export const tools = {
  cmake: {
    linux:['3.31.6',`${mirror}/github/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-x86_64.tar.gz`,'5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf','package/cmake-3.31.6-linux-x86_64/bin/cmake',true],
    win32:['3.31.6',`${mirror}/github/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-windows-x86_64.zip`,'d163cd3ab4959b0a53fa8988f2ddbd2e6c501658201e6a154386bad9dbe4f836','package/cmake-3.31.6-windows-x86_64/bin/cmake.exe',true]
  },
  pwsh:['7.5.4',`${mirror}/github/PowerShell/PowerShell/releases/download/v7.5.4/powershell-7.5.4-linux-x64.tar.gz`,'1fd7983fe56ca9e6233f126925edb24bf6b6b33e356b69996d925c4db94e2fef','package/pwsh',true],
  ninja: {
    linux:['1.12.1',`${mirror}/github/ninja-build/ninja/releases/download/v1.12.1/ninja-linux.zip`,'6f98805688d19672bd699fbbfa2c2cf0fc054ac3df1f0e6a47664d963d530255','ninja'],
    win32:['1.12.1',`${mirror}/github/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip`,'f550fec705b6d6ff58f2db3c374c2277a37691678d6aba463adcbb129108467a','ninja.exe']
  },
  sccache: {
    linux:['0.10.0',`${mirror}/github/mozilla/sccache/releases/download/v0.10.0/sccache-v0.10.0-x86_64-unknown-linux-musl.tar.gz`,'1fbb35e135660d04a2d5e42b59c7874d39b3deb17de56330b25b713ec59f849b','sccache-v0.10.0-x86_64-unknown-linux-musl/sccache'],
    win32:['0.10.0',`${mirror}/github/mozilla/sccache/releases/download/v0.10.0/sccache-v0.10.0-x86_64-pc-windows-msvc.zip`,'6d8823b5c13e0dba776d88c537229256ecb2f01a1d775b507fd141cb55d30578','sccache-v0.10.0-x86_64-pc-windows-msvc/sccache.exe']
  },
  // Windows builds too, so ci-check renders a repository's manifests on a home PC. Helm and
  // kustomize are the versions the home cluster's Argo CD (v3.6.1) bundles, so a check renders
  // a chart as Argo CD does (argo-cd hack/tool-versions.sh); they move with an Argo CD upgrade.
  helm: {
    linux:['4.3.1', `${mirror}/helm-downloads/helm-v4.3.1-linux-amd64.tar.gz`, '0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b', 'linux-amd64/helm'],
    win32:['4.3.1', `${mirror}/helm-downloads/helm-v4.3.1-windows-amd64.zip`, 'fcfd7b796dcf0f225abc40b5636a3b01f55f3de2fb1dfb18475df94e62c14112', 'windows-amd64/helm.exe']
  },
  kustomize: {
    linux:['5.8.3', `${mirror}/github/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz`, 'cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61', 'kustomize'],
    win32:['5.8.3', `${mirror}/github/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_windows_amd64.zip`, '763c4040ff01435bfce39661072452ebdf1cf2808bb91f5708ab4420834fbd42', 'kustomize.exe']
  },
  kubeconform: {
    linux:['0.8.0', `${mirror}/github/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz`, '9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883', 'kubeconform'],
    // The release's Windows build is netgo: its resolver asks the network adapters' DNS servers
    // and skips the Windows name rules, where Tailscale sends home.romaine.life when the PC is away
    // from home, so it couldn't reach the schemas there (AHT-184). Built from the release's
    // source with Go's default resolver, it asks Windows. Go comes from PATH.
    win32:['0.8.0', `${mirror}/github/yannh/kubeconform/archive/refs/tags/v0.8.0.tar.gz`, 'c345de9c3207f2d24628c64fe3cb9bed55c4248b12c181efe81ee907d6c994f2', 'built/kubeconform.exe', {go: 'kubeconform-0.8.0/cmd/kubeconform'}]
  },
  actionlint: {
    linux:['1.7.7', `${mirror}/github/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz`, '023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757', 'actionlint'],
    win32:['1.7.7', `${mirror}/github/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_windows_amd64.zip`, '7f12f1801bca3d480d67aaf7774f4c2a6359a3ca8eebe382c95c10c9704aa731', 'actionlint.exe']
  },
  cargoAudit: {
    linux:['0.22.2',`${mirror}/github/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/cargo-audit-x86_64-unknown-linux-musl-v0.22.2.tgz`,'7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428','cargo-audit-x86_64-unknown-linux-musl-v0.22.2/cargo-audit'],
    win32:['0.22.2',`${mirror}/github/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/cargo-audit-x86_64-pc-windows-msvc-v0.22.2.zip`,'0a7316540862c13d954f648917ceacca593747baed6eec180fafa590be2710ab','cargo-audit-x86_64-pc-windows-msvc-v0.22.2/cargo-audit.exe']
  },
  goreleaser: {
    linux:['2.20.2',`${mirror}/github/goreleaser/goreleaser/releases/download/v2.20.2/goreleaser_Linux_x86_64.tar.gz`,'f3d24969a7389a46613875711d15a96d8f6ef1553d84c6ace09d69ac1e7d44c0','goreleaser'],
    win32:['2.20.2',`${mirror}/github/goreleaser/goreleaser/releases/download/v2.20.2/goreleaser_Windows_x86_64.zip`,'d230d6def8b6059b277d472a2790501516b429ffe83b91469daad8b7736b8a5d','goreleaser.exe']
  },
  // A Rust build for a Linux target at a glibc floor, or for another architecture: zig is the
  // C toolchain and linker cargo-zigbuild drives. Zig ships on PyPI as a wheel holding it whole.
  zig: ['0.17.0', 'https://artifacts.home.romaine.life/pypi/pypi/simple/ziglang/ziglang-0.17.0.post0-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.musllinux_1_1_x86_64.whl', 'c9528d6a2cdf56a701bb8cafbc9967f59d88ecc8bb42b87ec2f9693418f69ce3', 'package/ziglang/zig', true],
  cargoZigbuild: ['0.24.0', `${mirror}/github/rust-cross/cargo-zigbuild/releases/download/v0.24.0/cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz`, '52be2cb85ad3875682564a29bac1832b2ab3db68b1c504765c92d5249cc9b96f', 'cargo-zigbuild-x86_64-unknown-linux-musl/cargo-zigbuild'],
  osslsigncode: ['2.8-2', 'https://artifacts.home.romaine.life/debian/ubuntu/pool/universe/o/osslsigncode/osslsigncode_2.8-2_amd64.deb', '1aee7be603102633e80b4c67cd939bba2e16a62813e4a3035696727783f632b0', 'usr/bin/osslsigncode']
};
// Windows' own tar (bsdtar) reads zips and tarballs; a GNU tar earlier on PATH, as in Git
// Bash, takes a C: path for a remote host.
export const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
export async function tool(name) {
  if (process.env[`CI_TOOL_${name.toUpperCase()}`]) return process.env[`CI_TOOL_${name.toUpperCase()}`];
  const spec=tools[name];
  if (process.platform !== 'linux' && !spec?.[process.platform]) throw new Error(`${name} suite needs Linux; local tools may be supplied on PATH via CI_TOOL_<NAME>`);
  const [version, url, sha, binary, fullPackage] = (Array.isArray(spec) ? spec : spec?.[process.platform]) || [];
  if (!version) throw new Error(`unlisted tool: ${name}`);
  const root = kept(`tools/${name}/${version}`);
  const executable = path.join(root, binary);
  if (fs.existsSync(executable)) return executable;
  const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`${name} download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== sha) throw new Error(`${name} checksum mismatch`);
  const temp = fs.mkdtempSync(path.join(root, '.install-'));
  try {
    const archive = path.join(temp, 'tool.tar.gz');
    fs.writeFileSync(archive, bytes);
    if (fullPackage?.go) {
      // A source archive with its modules vendored, so the build fetches nothing.
      run(tar, ['-xf', archive, '-C', temp]);
      const built = path.join(temp, path.basename(binary));
      run('go', ['build', '-p', '4', '-mod=vendor', '-trimpath', '-ldflags=-s -w', '-o', built, '.'],
        {cwd: path.join(temp, fullPackage.go), env: {CGO_ENABLED: '0', GOFLAGS: '', GOTOOLCHAIN: 'local'}});
      fs.mkdirSync(path.dirname(executable), {recursive: true});
      try { fs.renameSync(built, executable); }
      catch (error) { if (!fs.existsSync(executable)) throw error; }
      return executable;
    }
    if (fullPackage) {
      const packageDir=path.join(temp,'package');fs.mkdirSync(packageDir);
      if(url.endsWith('.whl') && process.platform==='linux')run('unzip',['-q',archive,'-d',packageDir]);
      else run(tar,['-xf',archive,'-C',packageDir]);
      fs.chmodSync(path.join(temp,binary),0o755);
      try{fs.renameSync(packageDir,path.join(root,'package'));}catch(error){if(!fs.existsSync(executable))throw error;}
      return executable;
    }
    if (url.endsWith('.deb')) run('dpkg-deb',['-x',archive,temp]);
    else if (url.endsWith('.zip') && process.platform==='linux') run('unzip',['-q',archive,binary,'-d',temp]);
    else run(tar, ['-xf', archive, '-C', temp, binary]);
    fs.mkdirSync(path.dirname(executable), {recursive: true});
    try { fs.renameSync(path.join(temp, binary), executable); }
    catch (error) { if (!fs.existsSync(executable)) throw error; }
    return executable;
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
