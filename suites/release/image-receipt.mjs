import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {api,request} from '../lib.mjs';
import {materializeAsset} from './protocol.mjs';
export async function previousImageReceipt(image) {
  const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'image-receipt-'));
  try {
    for(let page=1;;page++) {
      const releases=await request(`${api()}/releases?draft=false&limit=50&page=${page}`);
      for(const release of releases.filter(r=>!r.draft && !r.prerelease && r.assets?.some(a=>a.name==='image-inputs.json'))) {
        const file=path.join(root,'receipt.json');await materializeAsset('image-inputs.json',file,release);
        const value=JSON.parse(fs.readFileSync(file,'utf8'));
        if(value.image!==image)continue;
        if(value.version!==1 || !/^[0-9a-f]{64}$/.test(value.fingerprint) || !value.pin.startsWith(`${image}:`) || !/@sha256:[0-9a-f]{64}$/.test(value.pin))throw new Error('invalid published image receipt');
        return value;
      }
      if(releases.length<50)return null;
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
