import fs from 'node:fs';
import path from 'node:path';
import {capture, hash, kept, tracked} from '../lib.mjs';
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export function dotnetCache() {
  if (process.env.VERSION) {
    process.env.InformationalVersion=process.env.VERSION;
    process.env.VERSION=process.env.VERSION.replace(/^v/,'');
    process.env.IncludeSourceRevisionInInformationalVersion='false';
  }
  const repo=(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g,'-');
  const sdk=capture('dotnet',['--version']);
  const root=kept(`dotnet/${repo}/${sdk}/${process.env.GITHUB_JOB || 'local'}`);
  const props=path.join(root,'cache.props');
  const groups=tracked().filter(f=>/\.(?:cs|fs|vb)proj$/.test(f)).map(file=>{
    const dir=kept(`dotnet/${repo}/${sdk}/${process.env.GITHUB_JOB || 'local'}/${hash(file).slice(0,16)}`);
    let parent=path.dirname(path.resolve(file)),original='';
    while(true) {
      if(fs.existsSync(path.join(parent,'Directory.Build.props'))) {original=path.join(parent,'Directory.Build.props');break;}
      if(parent===process.cwd() || parent===path.dirname(parent))break;
      parent=path.dirname(parent);
    }
    const condition=`'$(MSBuildProjectFullPath)' == '${xml(path.resolve(file))}'`;
    return `${original ? `<Import Project="${xml(original)}" Condition="${condition}"/>` : ''}<PropertyGroup Condition="${condition}"><BaseIntermediateOutputPath>${xml(dir)}/obj/</BaseIntermediateOutputPath><BaseOutputPath>${xml(dir)}/bin/</BaseOutputPath><DefaultItemExcludes>$(DefaultItemExcludes);**/obj/**;**/bin/**</DefaultItemExcludes></PropertyGroup>`;
  });
  fs.writeFileSync(props,`<Project>${groups.join('')}</Project>`);
  process.env.DirectoryBuildPropsPath=props;
  process.env.NUGET_PACKAGES=kept('nuget-packages');
}
