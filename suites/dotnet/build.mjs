import fs from 'node:fs';
import path from 'node:path';
import {run, tracked} from '../lib.mjs';
import {dotnetCache} from './common.mjs';

// The projects a release publishes: every project that isn't a test project and that no other
// project references, as a solution's entry points are.
export function entryProjects(files = tracked(), read = file => fs.readFileSync(file, 'utf8')) {
  const projects = files.filter(file => /\.(?:cs|fs|vb)proj$/.test(file));
  const referenced = new Set();
  for (const project of projects) {
    for (const [, include] of read(project).matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      referenced.add(path.posix.normalize(path.posix.join(path.posix.dirname(project), include.replaceAll('\\', '/'))));
    }
  }
  const test = text => /<IsTestProject>\s*true\s*<\/IsTestProject>|Include="Microsoft\.NET\.Test\.Sdk"/i.test(text);
  return projects.filter(project => !referenced.has(project) && !test(read(project)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'build.mjs')) {
  dotnetCache();
  const projects = entryProjects();
  if (!projects.length) throw new Error('a .NET release publishes the projects no other project references, and every project is a test or referenced');
  for (const project of projects) {
    run('dotnet',['restore',project,'--locked-mode','--disable-parallel']);
    run('dotnet',['publish',project,'--no-restore','--configuration','Release','-maxcpucount:4','--output',path.resolve('dist',path.basename(project,path.extname(project)))]);
  }
}
