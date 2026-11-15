import {run} from '../lib.mjs';
import {dotnetCache} from './common.mjs';
dotnetCache();
run('dotnet',['restore','--locked-mode','--disable-parallel']);
run('dotnet',['format','--verify-no-changes','--no-restore']);
run('dotnet',['test','--no-restore','--configuration','Release','-maxcpucount:4']);
