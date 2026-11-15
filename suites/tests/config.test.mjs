import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config} from '../config.mjs';
test('unknown configuration and unsafe paths fail visibly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
  const file = path.join(dir,'config.json');
  try {
    for (const bad of [{version:2},{version:1,go:{command:'whatever'}},{version:1,inputs:{'go.test':['../other']}},{version:1,go:{platforms:['linux']}},{version:1,release:{toolchains:['go'],prefix:'v0.1',prefixFrom:'Cargo.toml'}},
      ...[[],{}, {'release.tag':'command'}, {'__proto__.tag':'tag'}].map(pinFields=>({version:1,cluster:{pinFile:'k8s/values.yaml',pinFields}})),
      {version:1,web:{pinFields:{'release.tag':'tag'}}}]) {
      fs.writeFileSync(file,JSON.stringify(bad)); assert.throws(() => config(file));
    }
    fs.writeFileSync(file,JSON.stringify({version:1,go:{platforms:['windows-latest','ubuntu-latest']},inputs:{'go.test':['assets/**']}}));
    assert.equal(config(file).version,1);
    fs.writeFileSync(file,JSON.stringify({version:1,cluster:{pinFile:'k8s/values.yaml',pinFields:{'release.tag':'tag','release.commit':'commit','release.version':'version'}}}));
    assert.equal(config(file).cluster.pinFields['release.commit'],'commit');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
