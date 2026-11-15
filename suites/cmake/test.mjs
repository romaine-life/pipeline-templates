import path from 'node:path';
import {capture, kept, run, hash} from '../lib.mjs';
import {tool} from '../tools.mjs';
import {msvc} from './msvc.mjs';
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
  process.env.SCCACHE_DIR=kept('sccache');
  const compilerCache=await tool('sccache');
  run('cmake',['--preset','ci','-B',dir,`-DCMAKE_MAKE_PROGRAM=${await tool('ninja')}`,`-DCMAKE_C_COMPILER_LAUNCHER=${compilerCache}`,`-DCMAKE_CXX_COMPILER_LAUNCHER=${compilerCache}`]);
  run('cmake',['--build',dir,'--config','Release','--parallel','4']);
  return dir;
}
if (process.argv[1]?.endsWith('/cmake/test.mjs') || process.argv[1]?.endsWith('\\cmake\\test.mjs')) {
  run('ctest',['--test-dir',await configureBuild(),'-C','Release','--output-on-failure','--parallel','4']);
}
