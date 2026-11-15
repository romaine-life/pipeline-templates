import fs from 'node:fs';
import path from 'node:path';
import {capture, run, tracked} from '../lib.mjs';
import {config} from '../config.mjs';
import {cargoCache} from './cache.mjs';
cargoCache(`release-${process.platform}`);
const cfg = config().rust || {};
const target=process.env.RELEASE_TARGET;
const features=process.env.RELEASE_FEATURES===undefined ? cfg.features : process.env.RELEASE_FEATURES.split(',').filter(Boolean);
const noDefault=process.env.RELEASE_NO_DEFAULT===undefined ? cfg.noDefaultFeatures : process.env.RELEASE_NO_DEFAULT==='true';
run('cargo', ['build', '-j', '4', '--locked', '--release', '--workspace', ...(target ? ['--target',target] : []),
  ...(noDefault ? ['--no-default-features'] : []), ...(features?.length ? ['--features', features.join(',')] : [])]);
const metadata = JSON.parse(capture('cargo', ['metadata', '--no-deps', '--format-version', '1']));
fs.mkdirSync('dist', {recursive: true});
const list=config().release?.sourceLists?.[process.env.RELEASE_PART || `rust-${target}`];
const dependencies=new Set(),owned=new Set(list?tracked():[]);
for (const pkg of metadata.packages.filter(p => metadata.workspace_members.includes(p.id))) {
  for (const output of pkg.targets.filter(t => t.kind.includes('bin') || t.kind.includes('cdylib'))) {
    const platformTarget=process.env.RELEASE_TARGET,windows=platformTarget?platformTarget.includes('windows'):process.platform==='win32';
    const library=output.kind.includes('cdylib'),stem=library?output.name.replaceAll('-','_'):output.name;
    const extension=library?(windows?'.dll':'.so'):(windows?'.exe':'');
    const name=`${library && !windows?'lib':''}${stem}${extension}`;
    const directory=path.join(process.env.CARGO_TARGET_DIR,...(platformTarget?[platformTarget]:[]),'release');
    fs.copyFileSync(path.join(directory,name),path.join('dist',`${library && !windows?'lib':''}${stem}${platformTarget?`-${platformTarget}`:''}${extension}`));
    if(list) {
      const dependency=fs.readFileSync(path.join(directory,`${library && !windows?'lib':''}${stem}.d`),'utf8').split(/\r?\n/).find(line=>line.includes(': '));
      if(!dependency)throw new Error('Cargo did not emit a source dependency list');
      for(const token of dependency.slice(dependency.indexOf(': ')+2).match(/(?:\\.|[^\s])+/g) || []) {
        const source=path.relative(process.cwd(),path.resolve(token.replace(/\\([ #])/g,'$1'))).replaceAll('\\','/');
        if(owned.has(source))dependencies.add(source);
      }
      if(!dependencies.size)throw new Error('Cargo source list contains no tracked inputs');
      fs.writeFileSync(path.join('dist',list),[...dependencies].sort().join('\n')+'\n');
    }
  }
}
