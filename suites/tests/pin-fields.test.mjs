import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import os from 'node:os';
import path from 'node:path';
import {updatePin} from '../cluster-service/pin-fields.mjs';
import {imagePins, pinFile} from '../layout.mjs';
import {pinnedImage} from '../release.mjs';

test('Spotify origin values update the image and the stager release atomically, preserving comments',()=>{
  const original=fs.readFileSync(new URL('./fixtures/spotify-values.yaml',import.meta.url),'utf8');
  const cfg={image:'forgejo.romaine.life/nelsong6/spotify-player'};
  const pin=`${cfg.image}:v0.25.1.99@sha256:${'b'.repeat(64)}`,values={tag:'v0.25.1.99',commit:'a'.repeat(40)};
  const updated=updatePin(original,cfg,pin,values),parsed=YAML.parse(updated);
  assert.equal(parsed.image,pin);assert.deepEqual(parsed.release,{tag:values.tag,commit:values.commit});
  assert.equal(parsed.host,YAML.parse(original).host);assert.ok(updated.includes('# The session runs here'));
  assert.equal(updatePin(updated,cfg,pin,values),updated);
  assert.equal(YAML.parse(updatePin(updated,cfg,pin,{...values,commit:'c'.repeat(40)})).release.commit,'c'.repeat(40));
  assert.equal(YAML.parse(updatePin('image: '+pin+'\nrelease:\n  version: old\n',cfg,pin,values)).release.version,'0.25.1.99');
  assert.throws(()=>updatePin('image: '+pin+'\nrelease:\n  missing: old\n',cfg,pin,values),/not a pin field/);
  assert.throws(()=>updatePin(original,cfg,pin,{tag:'v1',commit:''}),/source commit/);
  // A file without a release map has only its image moved, as it was written.
  assert.equal(updatePin('# kept\nimage: '+pin.replace('v0.25.1.99','v0.1.0')+'\n',cfg,pin,values),'# kept\nimage: '+pin+'\n');
});

test('a date pin field records when the release was pinned, to the second', () => {
  const pin = `romainecr.azurecr.io/app:v1.5.3@sha256:${'d'.repeat(64)}`;
  const original = `image: romainecr.azurecr.io/app:v1.5.2@sha256:${'c'.repeat(64)}\nrelease:\n  version: "1.5.2"\n  date: "2026-11-14T18:22:55Z"\n`;
  const updated = YAML.parse(updatePin(original, {image: 'romainecr.azurecr.io/app'}, pin,
    {tag: 'v1.5.3', commit: 'a'.repeat(40), date: new Date('2026-11-17T03:30:12.345Z')}));
  assert.deepEqual(updated.release, {version: '1.5.3', date: '2026-11-17T03:30:12Z'});
  assert.equal(updated.image, pin);
});

test("PR pin fields name the release commit's merged PR, and stay empty for a direct push", () => {
  const pin = `romainecr.azurecr.io/app:v1.0.9@sha256:${'d'.repeat(64)}`;
  const original = `image:\n  tag: "romainecr.azurecr.io/app:v1.0.8@sha256:${'c'.repeat(64)}"\nrelease:\n  prTitle: "old"\n  prNumber: "1"\n  prUrl: "u"\n  commit: "abc"\n`;
  const cfg = {image: 'romainecr.azurecr.io/app'};
  const values = {tag: 'v1.0.9', commit: 'a'.repeat(40)};
  const text = updatePin(original, cfg, pin, {...values, pr: {number: 42, title: 'A "quoted": title that runs on well past the eighty columns a YAML writer folds at', html_url: 'https://forgejo.example/o/r/pulls/42'}});
  const merged = YAML.parse(text);
  assert.deepEqual(merged.release, {prTitle: 'A "quoted": title that runs on well past the eighty columns a YAML writer folds at', prNumber: '42', prUrl: 'https://forgejo.example/o/r/pulls/42', commit: 'a'.repeat(40)});
  // Never folded: the next release finds the pin on one line.
  assert.ok(text.includes(`"${pin}"`), text);
  const direct = YAML.parse(updatePin(original, cfg, pin, {...values, pr: null}));
  assert.deepEqual(direct.release, {prTitle: '', prNumber: '', prUrl: '', commit: 'a'.repeat(40)});
});

// An upstream chart vendored unpacked, as OpenProject's is, names its image by separate values
// (OPADMIN-37): the map that makes the image is the pin, found, read and moved like the string.
const chartImage = 'forgejo.romaine.life/nelsong6/openproject';
const chartValues = (tag, hex) => `# The chart's values (OPADMIN-23).
serve: true

openproject:
  # The chart names this image by its digest alone when sha256 is set; the tag says which
  # release the digest is.
  image:
    registry: forgejo.romaine.life
    repository: nelsong6/openproject
    tag: ${tag}  # the release
    sha256: ${hex}
    imagePullPolicy: IfNotPresent
  dbInit:
    image:
      tag: 16@sha256:${'f'.repeat(64)}
`;

test("a chart's separate image fields are the pin: found, read as one string, and moved in place", () => {
  const original = chartValues('v0.1.0', 'c'.repeat(64));
  const files = {'k8s/values.yaml': original, 'k8s/templates/routes.yaml': '{{- if .Values.serve }}\nkind: HTTPRoute\n{{- end }}\n',
    'k8s/charts/openproject/values.yaml': 'image:\n  registry: docker.io\n  repository: openproject/openproject\n  tag: 17.9.4-slim\n'};
  assert.equal(pinFile(chartImage, Object.keys(files), file => files[file]), 'k8s/values.yaml');
  assert.deepEqual(imagePins(chartImage, original), [`${chartImage}:v0.1.0@sha256:${'c'.repeat(64)}`]);
  const pin = `${chartImage}:v0.1.1@sha256:${'d'.repeat(64)}`;
  const updated = updatePin(original, {image: chartImage}, pin, {tag: 'v0.1.1', commit: 'a'.repeat(40)});
  // Only the tag and digest change; every comment and other value stays as written.
  assert.equal(updated, chartValues('v0.1.1', 'd'.repeat(64)));
  assert.deepEqual(imagePins(chartImage, updated), [pin]);
  assert.equal(updatePin(updated, {image: chartImage}, pin), updated);
  // The release map's pin fields move with it.
  const withRelease = YAML.parse(updatePin(`${original}release:\n  tag: v0.1.0\n`, {image: chartImage}, pin, {tag: 'v0.1.1', commit: 'a'.repeat(40)}));
  assert.equal(withRelease.release.tag, 'v0.1.1');
  assert.deepEqual(withRelease.openproject.image, {registry: 'forgejo.romaine.life', repository: 'nelsong6/openproject', tag: 'v0.1.1', sha256: 'd'.repeat(64), imagePullPolicy: 'IfNotPresent'});
});

test("a Bitnami-style digest field is a pin too; a map without a digest, or of another image, is not", () => {
  const image = 'forgejo.romaine.life/o/app', hex = 'e'.repeat(64);
  const bitnami = `image:\n  registry: forgejo.romaine.life\n  repository: o/app\n  tag: "v1.0.0"\n  digest: "sha256:${hex}"\n`;
  assert.deepEqual(imagePins(image, bitnami), [`${image}:v1.0.0@sha256:${hex}`]);
  assert.equal(updatePin(bitnami, {image}, `${image}:v1.0.1@sha256:${'1'.repeat(64)}`, {tag: 'v1.0.1', commit: 'a'.repeat(40)}),
    `image:\n  registry: forgejo.romaine.life\n  repository: o/app\n  tag: "v1.0.1"\n  digest: "sha256:${'1'.repeat(64)}"\n`);
  // A plain tag stays plain, unless YAML would read the new one as something other than text.
  const plain = bitnami.replace('"v1.0.0"', 'v1.0.0');
  assert.match(updatePin(plain, {image}, `${image}:v1.0.1@sha256:${hex}`, {tag: 'v1.0.1', commit: 'a'.repeat(40)}), /\n  tag: v1\.0\.1\n/);
  assert.match(updatePin(plain, {image}, `${image}:1.1@sha256:${hex}`, {tag: '1.1', commit: 'a'.repeat(40)}), /\n  tag: "1\.1"\n/);
  // Before the first pin: no digest yet, an empty one, or the upstream image is no pin, and a
  // release that finds none says so.
  for (const text of ['image:\n  registry: forgejo.romaine.life\n  repository: o/app\n  tag: v1.0.0\n',
    'image:\n  registry: forgejo.romaine.life\n  repository: o/app\n  tag: v1.0.0\n  digest: ""\n',
    `image:\n  registry: docker.io\n  repository: o/app\n  tag: v1.0.0\n  sha256: ${hex}\n`]) {
    assert.deepEqual(imagePins(image, text), []);
    assert.equal(pinFile(image, ['values.yaml'], () => text), undefined);
    assert.throws(() => updatePin(text, {image}, `${image}:v1.0.1@sha256:${hex}`, {tag: 'v1.0.1', commit: 'a'.repeat(40)}), /no existing image pin/);
  }
  // A string pin and a field pin of the same release are one pin; of two releases, two.
  const string = `other: ${image}:v1.0.0@sha256:${hex}\n`;
  assert.equal(imagePins(image, bitnami + string).length, 1);
  assert.equal(imagePins(image, bitnami + string.replace('v1.0.0', 'v0.9.0')).length, 2);
});

test("the pinned release's tag is read from a chart's separate fields", () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'field-pin-'));
  try {
    process.chdir(root);
    fs.writeFileSync('values.yaml', chartValues('v0.1.0', 'c'.repeat(64)));
    assert.equal(pinnedImage({image: chartImage, pinFile: 'values.yaml'}), `${chartImage}:v0.1.0@sha256:${'c'.repeat(64)}`);
  } finally { process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true}); }
});
