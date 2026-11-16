import fs from 'node:fs';
import {run,capture} from '../lib.mjs';
import {imageLayout} from '../image-inputs.mjs';
export const fingerprintLabel='life.romaine.ci.image-inputs';
export function buildImage(cfg,image,fingerprint) {
  const {context,dockerfile}=imageLayout(cfg);
  run('docker',['build','--network','host','-f',dockerfile,...(fingerprint?['--label',`${fingerprintLabel}=${fingerprint}`]:[]),'-t',image,context],{env:{DOCKER_BUILDKIT:'1'}});
}
export function pushImage(image,remote) {
  run('docker',['tag',image,remote]);run('docker',['push',remote]);
  const repository=remote.slice(0,remote.lastIndexOf(':'));
  const digests=JSON.parse(capture('docker',['image','inspect',remote,'--format','{{json .RepoDigests}}']));
  const pin=digests.find(d=>d.startsWith(`${repository}@`));
  if(!pin || !/@sha256:[0-9a-f]{64}$/.test(pin))throw new Error('push produced no registry digest');
  fs.writeFileSync('.ci-image-pin',`${remote}@${pin.split('@')[1]}`);
  return fs.readFileSync('.ci-image-pin','utf8');
}
