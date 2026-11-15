import path from 'node:path';
import {config} from '../config.mjs';
import {run} from '../lib.mjs';
import {dotnetCache} from './common.mjs';
dotnetCache();
const projects=config().release?.dotnetProjects;
if (!projects?.length) throw new Error('release.dotnetProjects names the entry projects to publish');
for (const project of projects) {
  run('dotnet',['restore',project,'--locked-mode','--disable-parallel']);
  run('dotnet',['publish',project,'--no-restore','--configuration','Release','-maxcpucount:4','--output',path.resolve('dist',path.basename(project,path.extname(project)))]);
}
