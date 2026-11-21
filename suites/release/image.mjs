import fs from 'node:fs';
import {config} from '../config.mjs';
import {imageOperation} from '../cluster-service/image.mjs';
import {joinedCheck} from '../cluster-service/prior-image.mjs';
import {pinnedImage} from '../release.mjs';
const cfg=config();
const kind=cfg.release?.image;
// The PR run whose image the merge publishes, as a cluster service's or web app's own
// (cluster-service/prior-image.mjs), and on the PR, the check that keeps it.
const prior=joinedCheck(cfg.release);
// The scope found the image's inputs unchanged since the pinned image was built: the release
// carries that image on.
if (kind==='cluster' && process.argv[2]==='publish' && process.env.IMAGE_BUILD==='false') {
  const pin=pinnedImage(cfg.cluster);
  if (!pin) throw new Error(`${cfg.cluster.pinFile} pins no single ${cfg.cluster.image} image`);
  fs.writeFileSync('.ci-image-pin',pin);
  console.log(`Image inputs unchanged; the release keeps ${pin}`);
}
else if (kind==='cluster') await imageOperation(cfg.cluster,process.argv[2],undefined,prior);
else if (kind==='web') {
  const {run}=await import('../lib.mjs');
  await imageOperation(cfg.web,process.argv[2],async()=>run('az',['acr','login','--name',cfg.web.image.split('.')[0]]),prior);
}
if (kind && process.argv[2]==='publish') { fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('.ci-image-pin','dist/image.txt'); }
