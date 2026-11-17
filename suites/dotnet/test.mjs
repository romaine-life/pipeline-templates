import fs from 'node:fs';
import {run} from '../lib.mjs';
import {dotnetCache} from './common.mjs';
dotnetCache();
// A solution at the root is what the checks build, even beside a project there (a Godot mod's
// project sits at the root next to the solution that holds its tests); dotnet refuses to choose.
const solutions=fs.readdirSync('.').filter(f=>/\.slnx?$/.test(f));
if (solutions.length>1) throw new Error(`more than one solution at the root: ${solutions.join(', ')}`);
run('dotnet',['restore',...solutions,'--locked-mode','--disable-parallel']);
run('dotnet',['format',...solutions,'--verify-no-changes','--no-restore']);
run('dotnet',['test',...solutions,'--no-restore','--configuration','Release','-maxcpucount:4']);
