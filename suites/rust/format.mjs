import {run} from '../lib.mjs';
import {gbaFolders} from './gba.mjs';
run('cargo', ['fmt', '--all', '--', '--check']);
// A GBA crate is a workspace of its own (gba.mjs), which the root's --all doesn't reach.
for (const folder of gbaFolders().filter(folder => folder !== '.')) run('cargo', ['fmt', '--all', '--', '--check'], {cwd: folder});
