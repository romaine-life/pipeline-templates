import path from 'node:path';
import {capture} from '../lib.mjs';
export function msvc() {
  if (process.platform!=='win32') return;
  const vswhere=path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
  const install=capture(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath']);
  if (!install || install.includes('\n')) throw new Error('expected one MSVC build tools installation');
  const vcvars=path.join(install,'VC/Auxiliary/Build/vcvarsall.bat');
  const environment=capture('cmd.exe',['/d','/s','/c',`"call "${vcvars}" amd64 >nul && set"`],{windowsVerbatimArguments:true});
  for (const line of environment.split(/\r?\n/)) {
    const split=line.indexOf('=');if (split>0) process.env[line.slice(0,split)]=line.slice(split+1);
  }
}
