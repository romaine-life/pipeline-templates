import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {capture, kept, run, hash} from '../lib.mjs';
import {tool} from '../tools.mjs';
import {msvc} from './msvc.mjs';
import {vcpkg} from './vcpkg.mjs';
export function buildDirectory() {
  const version=capture('cmake',['--version']).split('\n')[0].replace(/[^\w.-]/g,'-');
  const repo=(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g,'-');
  return kept(`cmake/${repo}/${version}/${process.platform}/${process.env.GITHUB_JOB || 'local'}/${hash(process.cwd()).slice(0,16)}`);
}
export async function configureBuild() {
  const cmake=await tool('cmake');
  process.env.PATH=path.dirname(cmake)+path.delimiter+process.env.PATH;
  msvc();
  const dir=buildDirectory();
  const dependencies=await vcpkg(dir);
  process.env.SCCACHE_DIR=kept('sccache');
  const compilerCache=await tool('sccache');
  // Each build runs its own sccache server. On a host-network runner every job's container
  // shares 127.0.0.1, so a server another job started on sccache's fixed port compiled this
  // job's files from a filesystem where they don't exist.
  const server=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'sccache-'));
  if (process.platform==='win32') process.env.SCCACHE_SERVER_PORT=String(await freePort());
  else process.env.SCCACHE_SERVER_UDS=path.join(server,'server.sock');
  try {
    run('cmake',['--preset','ci','-B',dir,`-DCMAKE_MAKE_PROGRAM=${await tool('ninja')}`,`-DCMAKE_C_COMPILER_LAUNCHER=${compilerCache}`,`-DCMAKE_CXX_COMPILER_LAUNCHER=${compilerCache}`,...dependencies]);
    run('cmake',['--build',dir,'--config','Release','--parallel','4']);
  } finally {
    // A build that failed before its first compile started no server to stop.
    try { run(compilerCache,['--stop-server']); } catch {}
    fs.rmSync(server,{recursive:true,force:true});
  }
  return dir;
}
function freePort() {
  return new Promise((resolve,reject)=>{
    const probe=net.createServer().once('error',reject).listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});
  });
}
if (process.argv[1]?.endsWith('/cmake/test.mjs') || process.argv[1]?.endsWith('\\cmake\\test.mjs')) {
  run('ctest',['--test-dir',await configureBuild(),'-C','Release','--output-on-failure','--parallel','4']);
}
