import path from 'node:path';
import fs from 'node:fs';
import {run, suites} from '../lib.mjs';
import {dependencies} from './dependencies.mjs';
import {packageAssets} from './assets.mjs';
import {forgejoDependencies} from '../packages.mjs';
const kind=process.env.RELEASE_TOOLCHAIN || process.argv[2];
if (!['go','rust','npm','python','dotnet','cmake','powershell'].includes(kind)) throw new Error('unknown release toolchain');
fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');
// When the build happened (Unix seconds), beside its VERSION, for a program that shows both.
process.env.BUILD_TIME ??= String(Math.floor(Date.now()/1000));
await dependencies(kind);
// A release that embeds npm packages from Forgejo (fzt-desktop's frontend takes fzt-browser's)
// installs its root's packages before it builds; the package's own scripts put them in place.
if (kind!=='npm' && forgejoDependencies('.').length) run(process.platform==='win32' ? 'npm.cmd' : 'npm',['ci','--prefer-offline','--no-audit','--no-fund'],{shell:process.platform==='win32'});
run(process.execPath,[path.join(suites,kind==='npm' ? 'web-app' : kind,'build.mjs')]);
const staticAssets=path.join('release','assets',process.env.RELEASE_PART || kind);
// Each entry on its own: Node 22 counts dist/ itself as the collision when a folder is copied
// into it, and a static asset must never replace a built one.
if(fs.existsSync(staticAssets))for(const entry of fs.readdirSync(staticAssets))fs.cpSync(path.join(staticAssets,entry),path.join('dist',entry),{recursive:true,errorOnExist:true,force:false});
packageAssets({kind});
