import fs from 'node:fs';
import {config} from '../config.mjs';
import {imageOperation} from '../cluster-service/image.mjs';
const cfg=config();
const kind=cfg.release?.image;
if (kind==='cluster') await imageOperation(cfg.cluster,process.argv[2]);
else if (kind==='web') {
  const {run}=await import('../lib.mjs');
  await imageOperation(cfg.web,process.argv[2],async()=>run('az',['acr','login','--name',cfg.web.image.split('.')[0]]));
}
if (kind && process.argv[2]==='publish') { fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('.ci-image-pin','dist/image.txt'); }
