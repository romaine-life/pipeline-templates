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
  helm: ['3.22.1', `${mirror}/helm-downloads/helm-v3.22.1-linux-amd64.tar.gz`, '896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea', 'linux-amd64/helm'],
  kustomize: ['5.8.3', `${mirror}/github/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz`, 'cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61', 'kustomize'],
  kubeconform: ['0.8.0', `${mirror}/github/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz`, '9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883', 'kubeconform'],
  actionlint: ['1.7.7', `${mirror}/github/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz`, '023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757', 'actionlint'],
  osslsigncode: ['2.8-2', 'https://artifacts.home.romaine.life/debian/ubuntu/pool/universe/o/osslsigncode/osslsigncode_2.8-2_amd64.deb', '1aee7be603102633e80b4c67cd939bba2e16a62813e4a3035696727783f632b0', 'usr/bin/osslsigncode']
};
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
    if (fullPackage) {
      const packageDir=path.join(temp,'package');fs.mkdirSync(packageDir);
      run('tar',['-xf',archive,'-C',packageDir]);fs.chmodSync(path.join(temp,binary),0o755);
      try{fs.renameSync(packageDir,path.join(root,'package'));}catch(error){if(!fs.existsSync(executable))throw error;}
      return executable;
    }
    if (url.endsWith('.deb')) run('dpkg-deb',['-x',archive,temp]);
    else if (url.endsWith('.zip') && process.platform==='linux') run('unzip',['-q',archive,binary,'-d',temp]);
    else run('tar', ['-xf', archive, '-C', temp, binary]);
    fs.mkdirSync(path.dirname(executable), {recursive: true});
    try { fs.renameSync(path.join(temp, binary), executable); }
    catch (error) { if (!fs.existsSync(executable)) throw error; }
    return executable;
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
