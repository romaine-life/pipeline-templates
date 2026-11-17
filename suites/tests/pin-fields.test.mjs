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

test('a date pin field records when the release was pinned, to the second', () => {
  const pin = `romainecr.azurecr.io/app:v1.5.3@sha256:${'d'.repeat(64)}`;
  const original = `image: romainecr.azurecr.io/app:v1.5.2@sha256:${'c'.repeat(64)}\nrelease:\n  version: "1.5.2"\n  deployedAt: "2026-11-14T18:22:55Z"\n`;
  const updated = YAML.parse(updatePin(original, {image: 'romainecr.azurecr.io/app', pinFields: {'release.version': 'version', 'release.deployedAt': 'date'}}, pin,
    {tag: 'v1.5.3', commit: 'a'.repeat(40), date: new Date('2026-11-17T03:30:12.345Z')}));
  assert.deepEqual(updated.release, {version: '1.5.3', deployedAt: '2026-11-17T03:30:12Z'});
  assert.equal(updated.image, pin);
});

test("PR pin fields name the release commit's merged PR, and stay empty for a direct push", () => {
  const pin = `romainecr.azurecr.io/app:v1.0.9@sha256:${'d'.repeat(64)}`;
  const original = `image: romainecr.azurecr.io/app:v1.0.8@sha256:${'c'.repeat(64)}\nbuild:\n  prTitle: "old"\n  prNumber: "1"\n  prUrl: "u"\n  commit: "abc"\n`;
  const cfg = {image: 'romainecr.azurecr.io/app', pinFields: {'build.prTitle': 'prTitle', 'build.prNumber': 'prNumber', 'build.prUrl': 'prUrl', 'build.commit': 'commit'}};
  const values = {tag: 'v1.0.9', commit: 'a'.repeat(40)};
  const merged = YAML.parse(updatePin(original, cfg, pin, {...values, pr: {number: 42, title: 'A "quoted": title', html_url: 'https://forgejo.example/o/r/pulls/42'}}));
  assert.deepEqual(merged.build, {prTitle: 'A "quoted": title', prNumber: '42', prUrl: 'https://forgejo.example/o/r/pulls/42', commit: 'a'.repeat(40)});
  const direct = YAML.parse(updatePin(original, cfg, pin, {...values, pr: null}));
  assert.deepEqual(direct.build, {prTitle: '', prNumber: '', prUrl: '', commit: 'a'.repeat(40)});
});
