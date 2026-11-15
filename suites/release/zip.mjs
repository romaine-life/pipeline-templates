import fs from 'node:fs';
import path from 'node:path';
import {zipSync} from 'fflate';
export function directoryEntries(directory) {
  const entries=Object.create(null);
  function visit(dir,prefix='') {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name),name=prefix+entry.name;
      if (entry.isDirectory()) visit(file,`${name}/`);
      else if (entry.isFile()) entries[name]=fs.readFileSync(file);
      else throw new Error('release ZIP inputs must be regular files and directories');
    }
  }
  visit(directory);return entries;
}

export const zipDirectory=directory=>zipSync(directoryEntries(directory));
