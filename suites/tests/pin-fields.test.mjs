import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import {updatePin} from '../cluster-service/pin-fields.mjs';

test('Spotify origin values update the image and the stager release atomically, preserving comments',()=>{
  const original=fs.readFileSync(new URL('./fixtures/spotify-values.yaml',import.meta.url),'utf8');
  const cfg={image:'forgejo.romaine.life/nelsong6/spt-session',pinFields:{'release.tag':'tag','release.commit':'commit'}};
  const pin=`${cfg.image}:v0.25.1.99@sha256:${'b'.repeat(64)}`,values={tag:'v0.25.1.99',commit:'a'.repeat(40)};
  const updated=updatePin(original,cfg,pin,values),parsed=YAML.parse(updated);
  assert.equal(parsed.image,pin);assert.deepEqual(parsed.release,{tag:values.tag,commit:values.commit});
  assert.equal(parsed.host,YAML.parse(original).host);assert.ok(updated.includes('# The session runs here'));
  assert.equal(updatePin(updated,cfg,pin,values),updated);
  assert.equal(YAML.parse(updatePin(updated,cfg,pin,{...values,commit:'c'.repeat(40)})).release.commit,'c'.repeat(40));
  assert.equal(YAML.parse(updatePin('image: '+pin+'\nrelease:\n  version: old\n',{...cfg,pinFields:{'release.version':'version'}},pin,values)).release.version,'0.25.1.99');
  assert.throws(()=>updatePin(original,{...cfg,pinFields:{'release.missing':'tag'}},pin,values),/existing scalar/);
  assert.throws(()=>updatePin(original,cfg,pin,{tag:'v1',commit:''}),/source commit/);
});

test('the pin metadata audit covers the release inventory and documents every identified application field',()=>{
  const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url),'utf8'));
  const audit=read('./pin-audit.json'),assets=read('./asset-contracts.json');
  assert.deepEqual(Object.keys(audit.sources).sort(),[...assets.repositories.map(row=>row.repository),...assets.noRelease].sort());
  for(const row of audit.pinFiles) {
    assert.match(row.blob,/^[0-9a-f]{40}$/);assert.ok(audit.sources[row.repository]);
    const document=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
    assert.ok(document.includes(row.repository));for(const field of Object.keys(row.pinFields))assert.ok(document.includes(field));
  }
});
