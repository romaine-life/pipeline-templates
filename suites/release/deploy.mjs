import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {materializeAsset} from './protocol.mjs';
import {config} from '../config.mjs';
import {run,suites,requirePublish} from '../lib.mjs';
export async function deployJoined(materialize=materializeAsset,execute=run) {
  requirePublish();
  await materialize('image.txt','.ci-image-pin');
  const kind=config().release?.image;
  if(kind==='cluster')execute(process.execPath,[path.join(suites,'cluster-service/pin.mjs')]);
  else if(kind==='web')execute(process.execPath,[path.join(suites,'cluster-service/pin.mjs'),'web']);
  else throw new Error('joined deployment needs a declared image kind');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await deployJoined();
