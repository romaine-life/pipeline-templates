import fs from 'node:fs';
import path from 'node:path';
import {config} from '../config.mjs';
import {requirePublish, run, suites} from '../lib.mjs';
requirePublish();
const cfg = config().web || {};
if (cfg.pinFile) run(process.execPath,[path.join(suites,'cluster-service/pin.mjs'),'web']);
else if (cfg.containerApp && cfg.resourceGroup) {
  const pin=fs.readFileSync('.ci-image-pin','utf8').trim();
  run('az',['containerapp','update','--name',cfg.containerApp,'--resource-group',cfg.resourceGroup,'--image',pin]);
} else throw new Error('web image needs pinFile/workPackage or containerApp/resourceGroup');
