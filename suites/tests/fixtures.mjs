import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run, suites, templates, kept} from '../lib.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'suite-fixtures-'));
const previous = process.cwd();
const write = (file,text) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,text); };
const stage = name=>{fs.mkdirSync(`parts/${name}`,{recursive:true});fs.cpSync('dist',`parts/${name}`,{recursive:true});};
const script = (name,args=[]) => run(process.execPath,[path.join(suites,name),...args]);
try {
  process.chdir(root);
  process.env.DEFAULT_BRANCH='main'; process.env.GITHUB_REF='refs/heads/main'; process.env.GITHUB_EVENT_NAME='push';
  process.env.VERSION='v0.1.1';
  write('.gitignore','dist/\n**/bin/\n**/obj/\n**/__pycache__/\n**/.pytest_cache/\n**/.venv/\n');
  const goTargets=process.platform==='linux' ? [{goos:'windows',goarch:'amd64'},{goos:'linux',goarch:'arm64'},{goos:'darwin',goarch:'arm64'}] : [{goos:'windows',goarch:'amd64'}];
  fleetEntry(({version:1,release:{toolchains:['go','rust','npm','python','dotnet','cmake','powershell'],goTargets,windowsGui:['./cmd/fixture'],dotnetProjects:['dotnet-fixture/Fixture.csproj']}}));
  write('README.md','# Fixture\n');
  write('go.mod','module example.com/fixture\n\ngo 1.26.2\n');
  write('cmd/fixture/main.go','package main\n\nimport "fmt"\n\nvar version string\n\nfunc main() { fmt.Println(version) }\n');
  write('cmd/fixture/fixture.manifest','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="Fixture" type="win32"/><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><consoleAllocationPolicy xmlns="http://schemas.microsoft.com/SMI/2024/WindowsSettings">detached</consoleAllocationPolicy></windowsSettings></application></assembly>');
  write('cmd/fixture/main_test.go','package main\n\nimport "testing"\n\nfunc TestFixture(t *testing.T) { if 2 + 2 != 4 { t.Fatal("arithmetic") } }\n');
  run('gofmt',['-w','cmd/fixture/main.go','cmd/fixture/main_test.go']);
  write('Cargo.toml','[package]\nname="rust-fixture"\nversion="0.1.0"\nedition="2021"\n[lib]\ncrate-type=["cdylib"]\n[[bin]]\nname="rust-fixture-cli"\npath="src/main.rs"\n');
  write('src/lib.rs','#[no_mangle]\npub extern \"C\" fn answer() -> i32 {\n    42\n}\n');
  write('src/main.rs','fn main() {\n    println!("fixture");\n}\n\n#[test]\nfn fixture() {\n    assert_eq!(2 + 2, 4);\n}\n');
  run('cargo',['generate-lockfile']);
  write('frontend/package.json',JSON.stringify({name:'fixture',version:'1.0.0',scripts:{lint:'node -e "process.exit(0)"',test:'node -e "if (2+2!==4) process.exit(1)"',build:'node src/build.mjs'}}));
  write('frontend/package-lock.json',JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0'}}}));
  write('frontend/src/build.mjs',"import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','fixture');");
  write('CMakeLists.txt','cmake_minimum_required(VERSION 3.21)\nproject(fixture C)\ninclude(CTest)\nadd_executable(native_fixture native/fixture.c)\nadd_test(NAME fixture COMMAND native_fixture)\ninstall(TARGETS native_fixture RUNTIME DESTINATION bin)\n');
  write('native/fixture.c','int main(void) { return (2 + 2 != 4); }\n');
  write('CMakePresets.json',JSON.stringify({version:3,configurePresets:[{name:'ci',generator:'Ninja',binaryDir:'${sourceDir}/out',cacheVariables:{CMAKE_BUILD_TYPE:'Release',CMAKE_MSVC_DEBUG_INFORMATION_FORMAT:'Embedded'}}]}));
  run('dotnet',['new','xunit','--no-restore','-n','Fixture','-o','dotnet-fixture']);
  run('dotnet',['new','console','--no-restore','-n','App','-o','dotnet-app']);
  const cfg=currentEntry();cfg.release.dotnetProjects=['dotnet-app/App.csproj'];fleetEntry((cfg));
  run('dotnet',['new','sln','-n','Fixture']);run('dotnet',['sln','Fixture.sln','add','dotnet-fixture/Fixture.csproj','dotnet-app/App.csproj']);
  run('dotnet',['restore','--use-lock-file','--disable-parallel'],{env:{NUGET_PACKAGES:kept('nuget-packages'),VERSION:'0.1.1'}});
  write('python-fixture/pyproject.toml','[project]\nname="fixture-python"\nversion="0.1.0"\nrequires-python=">=3.12"\n[dependency-groups]\ndev=["ruff==0.14.5", "pytest==8.3.5"]\n[build-system]\nrequires=["hatchling==1.27.0"]\nbuild-backend="hatchling.build"\n');
  write('python-fixture/src/fixture_python/__init__.py','def add(a, b):\n    return a + b\n');
  write('python-fixture/tests/test_fixture.py','from fixture_python import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n');
  run('uv',['lock','--project','python-fixture'],{env:{UV_CACHE_DIR:kept('uv')}});
  write('tofu/main.tf','output "fixture" {\n  value = "fixture"\n}\n');
  write('commands/fixture.ps1','Write-Output fixture\n');
  write('parse.ps1','param([string]$Name)\nWrite-Output $Name\n');
  run('git',['init','-b','main']);
  run('git',['add','.']);
  run('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  process.env.BASE = (await import('../lib.mjs')).capture('git',['rev-parse','HEAD']);
  process.env.RELEASE_TOOLCHAIN='go';
  for (const name of ['go/format.mjs','go/test.mjs','release/build.mjs','rust/format.mjs','rust/test.mjs','rust/build.mjs','web-app/test.mjs','docs/validate.mjs','powershell/files.mjs','powershell/parse.mjs','tofu/plan.mjs','tofu/apply.mjs','cmake/test.mjs','cmake/build.mjs','dotnet/test.mjs','dotnet/build.mjs','python/test.mjs','python/build.mjs','web-app/build.mjs','powershell/build.mjs']) {script(name);if(name==='release/build.mjs')stage('go');}
  const triple=process.platform==='win32'?'x86_64-pc-windows-msvc':'x86_64-unknown-linux-gnu';
  cfg.release.rustTargets=[{target:triple}];cfg.release.sourceLists={[`rust-${triple}`]:'rust-inputs.txt'};fleetEntry((cfg));
  process.env.RELEASE_TOOLCHAIN='rust';process.env.RELEASE_PART=`rust-${triple}`;process.env.RELEASE_TARGET=triple;
  script('release/build.mjs');
  if(!fs.readFileSync('dist/rust-inputs.txt','utf8').includes('src/main.rs'))throw new Error('Cargo source receipt omitted tracked source');
  if(!fs.existsSync(`dist/${process.platform==='win32'?'rust_fixture-windows-amd64.dll':'librust_fixture-linux-amd64.so'}`))throw new Error('Rust cdylib was not staged');
  stage('rust');
  if(process.platform==='win32') {
    write('cmd/ffi/main.go','package main\n\nimport \"C\"\n\n//export Answer\nfunc Answer() C.int { return 42 }\n\nfunc main() {}\n');
    run('gofmt',['-w','cmd/ffi/main.go']);
    cfg.release.goTargets.push({goos:'windows',goarch:'amd64',buildmode:'c-shared',packages:['./cmd/ffi']});fleetEntry((cfg));
    process.env.RELEASE_TOOLCHAIN='go';process.env.RELEASE_TARGET='windows-amd64-c-shared';process.env.RELEASE_PART='go-windows-amd64-c-shared';
    script('release/build.mjs');if(!fs.existsSync('dist/ffi-windows-amd64.dll'))throw new Error('native Go C-shared DLL was not staged');stage('c-shared');
  }
  delete process.env.RELEASE_TARGET;delete process.env.RELEASE_PART;
  for(const kind of ['cmake','dotnet','python','npm','powershell']){process.env.RELEASE_TOOLCHAIN=kind;script('release/build.mjs');stage(kind);}
  fs.rmSync('dist',{recursive:true,force:true});
  script('release/assemble.mjs');
  if (process.platform === 'win32') {
    run('pwsh',['-NoProfile','-NonInteractive','-File',path.join(suites,'powershell/parse.ps1')]);
    run('powershell',['-NoProfile','-NonInteractive','-File',path.join(suites,'powershell/parse.ps1')]);
    run('pwsh',['-NoProfile','-NonInteractive','-File',path.join(suites,'release/sign-windows.ps1')]);
  }
  if (process.platform === 'linux') {
    const pe=fs.readFileSync('dist/fixture-windows-amd64.exe');
    const peOffset=pe.readUInt32LE(0x3c);
    if (pe.readUInt16LE(peOffset+24+68)!==2) throw new Error('Windows GUI subsystem was not linked');
    process.env.GITHUB_EVENT_NAME='pull_request';
    script('release/sign-linux.mjs');
    process.env.GITHUB_EVENT_NAME='push';
    script('rust/lint.mjs',['machete']);
    script('rust/lint.mjs',['typos']);
    script('rust/lint.mjs',['audit']);
    const pod='apiVersion: v1\nkind: Pod\nmetadata:\n  name: fixture\nspec:\n  containers:\n    - name: fixture\n      image: artifacts.home.romaine.life/dockerhub/library/alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f\n';
    write('k8s/pod.yaml',pod);
    write('k8s/kustomization.yaml','resources:\n- pod.yaml\n');
    // The renders follow k8s/: a kustomization, then a chart with a values- case beside it.
    run('git',['add','k8s']);
    fleetEntry(({version:1,suites:['cluster-service']}));
    script('cluster-service/manifests.mjs');
    run('git',['rm','-qf','k8s/kustomization.yaml']);
    write('k8s/Chart.yaml','apiVersion: v2\nname: fixture\nversion: 0.1.0\n');
    write('k8s/templates/pod.yaml',pod);
    write('k8s/values-case.yaml','case: true\n');
    run('git',['add','k8s']);
    script('cluster-service/manifests.mjs');
    if (process.env.CI_FIXTURE_DOCKER === '1') {
      write('Dockerfile','FROM artifacts.home.romaine.life/dockerhub/library/alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f\nENTRYPOINT ["/bin/true"]\n');
      script('cluster-service/image.mjs',['check']);
      const cfg=currentEntry();
      cfg.release={toolchains:['go'],image:'cluster'};
      // A cluster image is a cluster service's, selected by its cluster-image topic, and named
      // for the repository.
      fleetEntry((cfg));
      script('release/image.mjs',['check']);
    }
  }
} finally { process.chdir(previous); fs.rmSync(root,{recursive:true,force:true}); }
