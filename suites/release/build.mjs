import path from 'node:path';
import fs from 'node:fs';
import {run, suites} from '../lib.mjs';
import {dependencies} from './dependencies.mjs';
import {archives} from './archives.mjs';
import {config} from '../config.mjs';
import {packageAssets} from './assets.mjs';
const kind=process.env.RELEASE_TOOLCHAIN || process.argv[2];
if (!['go','rust','npm','python','dotnet','cmake','powershell'].includes(kind)) throw new Error('unknown release toolchain');
fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');
await dependencies(kind);
run(process.execPath,[path.join(suites,kind==='npm' ? 'web-app' : kind,'build.mjs')]);
const staticAssets=path.join('release','assets',process.env.RELEASE_PART || kind);
// Each entry on its own: Node 22 counts dist/ itself as the collision when a folder is copied
// into it, and a static asset must never replace a built one.
if(fs.existsSync(staticAssets))for(const entry of fs.readdirSync(staticAssets))fs.cpSync(path.join(staticAssets,entry),path.join('dist',entry),{recursive:true,errorOnExist:true,force:false});
archives(kind);
packageAssets({kind});
