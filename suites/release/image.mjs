import fs from 'node:fs';
import {config} from '../config.mjs';
import {imageOperation} from '../cluster-service/image.mjs';
import {joinedCheck} from '../cluster-service/prior-image.mjs';
import {clusterImages} from '../layout.mjs';
import {imageBuild,pinnedImage} from '../release.mjs';
const cfg=config();
const kind=cfg.release?.image;
// The PR run whose image the merge publishes, as a cluster service's or web app's own
// (cluster-service/prior-image.mjs), and on the PR, the check that keeps it.
const prior=joinedCheck(cfg.release);
// The images whose inputs the scope found unchanged since the pinned one was built (IMAGE_BUILD,
// release.mjs joinedImageChanged): the release carries each of them on.
if (kind==='cluster') {
  const changed=imageBuild(process.env.IMAGE_BUILD);
  const carried={};
  if (process.argv[2]==='publish') for (const section of clusterImages(cfg.cluster)) {
    if (changed(section.image)) continue;
    const pin=pinnedImage(section);
    if (!pin) throw new Error(`${section.pinFile} pins no single ${section.image} image`);
    carried[section.image]=pin;
  }
  await imageOperation(cfg.cluster,process.argv[2],undefined,{...prior,carried});
}
else if (kind==='web') {
  const {run}=await import('../lib.mjs');
  await imageOperation(cfg.web,process.argv[2],async()=>run('az',['acr','login','--name',cfg.web.image.split('.')[0]]),prior);
}
if (kind && process.argv[2]==='publish') { fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('.ci-image-pin','dist/image.txt'); }

