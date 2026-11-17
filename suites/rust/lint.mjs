import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {capture,kept,run,tracked} from '../lib.mjs';
import {tar,tool} from '../tools.mjs';
const name=process.argv[2];
if(name==='audit') {
  // RustSec's advisories as they are today, through Artifact Keeper: an audit is only as good
  // as its newest advisory, so the database is read fresh each run and never kept.
  const executable=await tool('cargoAudit'),db=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'advisory-db-'));
  try {
    const response=await fetch('https://artifacts.home.romaine.life/general/github/rustsec/advisory-db/archive/refs/heads/main.tar.gz',{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`advisory database download: HTTP ${response.status}`);
    fs.writeFileSync(path.join(db,'db.tar.gz'),Buffer.from(await response.arrayBuffer()));
    run(tar,['-xzf',path.join(db,'db.tar.gz'),'-C',db,'--strip-components=1']);
    run(executable,['audit','--db',db,'--no-fetch']);
  } finally {fs.rmSync(db,{recursive:true,force:true});}
  process.exit(0);
}
const specs={typos:['typos-cli','1.50.2','typos'],machete:['cargo-machete','0.9.2','cargo-machete']};
if(!specs[name])throw new Error('rust/lint.mjs typos|machete|audit');
const [pkg,version,binary]=specs[name];
const compiler=capture('rustc',['--version']).replace(/[^\w.-]/g,'-');
const root=kept(`rust-tools/${pkg}/${version}/${compiler}`),executable=path.join(root,'bin',`${binary}${process.platform==='win32' ? '.exe' : ''}`);
if(!fs.existsSync(executable))run('cargo',['install','--locked','-j','4','--root',root,`${pkg}@${version}`],{env:{CARGO_TARGET_DIR:kept(`rust-tools/${pkg}/${version}/${compiler}/target`),CARGO_BUILD_BUILD_DIR:kept(`rust-tools/${pkg}/${version}/${compiler}/target`)}});
if(name==='typos'){
  const files=tracked().filter(f=>/\.(rs|md|toml)$/.test(f));
  for(let i=0;i<files.length;i+=64)run(executable,files.slice(i,i+64));
}else run(executable,[]);
