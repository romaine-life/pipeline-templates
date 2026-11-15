import fs from 'node:fs';
import path from 'node:path';
import {capture,kept,run,tracked} from '../lib.mjs';
const name=process.argv[2];
const specs={typos:['typos-cli','1.50.2','typos'],machete:['cargo-machete','0.9.2','cargo-machete']};
if(!specs[name])throw new Error('rust/lint.mjs typos|machete');
const [pkg,version,binary]=specs[name];
const compiler=capture('rustc',['--version']).replace(/[^\w.-]/g,'-');
const root=kept(`rust-tools/${pkg}/${version}/${compiler}`),executable=path.join(root,'bin',`${binary}${process.platform==='win32' ? '.exe' : ''}`);
if(!fs.existsSync(executable))run('cargo',['install','--locked','-j','4','--root',root,`${pkg}@${version}`],{env:{CARGO_TARGET_DIR:kept(`rust-tools/${pkg}/${version}/${compiler}/target`)}});
if(name==='typos'){
  const files=tracked().filter(f=>/\.(rs|md|toml)$/.test(f));
  for(let i=0;i<files.length;i+=64)run(executable,files.slice(i,i+64));
}else run(executable,[]);
