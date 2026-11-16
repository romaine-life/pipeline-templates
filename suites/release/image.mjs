import {randomUUID} from 'node:crypto';
import {previousImageReceipt} from './image-receipt.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.mjs';
import {run,capture,requirePublish} from '../lib.mjs';
import {imageOperation,withRegistry} from '../cluster-service/image.mjs';
import {fingerprintLabel} from '../cluster-service/docker.mjs';
import {imageFingerprint,pinnedImage} from '../image-inputs.mjs';

export async function publishJoinedImage(cfg=config(),publish=imageOperation) {
  requirePublish();
  const kind=cfg.release?.image;if(!kind)return;
  const section=cfg[kind],fingerprint=imageFingerprint(cfg,kind);
  const receipt=await previousImageReceipt(section.image);
  const previous=receipt?.pin || pinnedImage(section);
  const login=kind==='web'?async()=>run('az',['acr','login','--name',section.image.split('.')[0]]):undefined;
  let last=receipt?.fingerprint;
  if(!last && section.imageSource) {
    run('git',['fetch','--no-tags','--depth=1','origin',section.imageSource],{env:{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from(`x-access-token:${process.env.TOKEN}`).toString('base64')}`}});
    last=imageFingerprint(cfg,kind,section.imageSource);
  }
  if(!last)last=await withRegistry(section,login,async()=>{
    run('docker',['pull',previous]);
    const labels=JSON.parse(capture('docker',['image','inspect',previous,'--format','{{json .Config.Labels}}'])) || {};
    if(!labels[fingerprintLabel])throw new Error('existing image has no input receipt; set imageSource to its verified build commit for migration');
    return labels[fingerprintLabel];
  });
  if(last===fingerprint) {
    fs.writeFileSync('.ci-image-pin',previous);
    console.log(`Image inputs unchanged; retaining ${previous}`);
  } else {
    await publish(section,'publish',login,fingerprint);
  }
  fs.copyFileSync('.ci-image-pin','dist/image.txt');
  fs.writeFileSync('dist/image-inputs.json',JSON.stringify({version:1,image:section.image,fingerprint,pin:fs.readFileSync('.ci-image-pin','utf8')}));
  return {published:last!==fingerprint,pin:fs.readFileSync('.ci-image-pin','utf8'),fingerprint};
}
export async function checkJoinedImage(cfg=config()) {
  const kind=cfg.release?.image;if(!kind)return;
  const section=cfg[kind],image=`ci-release-runtime-${randomUUID()}:check`;
  const {buildImage}=await import('../cluster-service/docker.mjs');
  fs.writeFileSync('.ci-runtime-image',image);
  try {
  buildImage(section,image);
  for(const check of cfg.release.runtimeChecks || []) {
    const file=path.resolve('dist',check.asset);
    if(!fs.statSync(file).isFile())throw new Error(`runtime asset missing: ${check.asset}`);
    fs.chmodSync(file,0o755);
    const name=`ci-runtime-${randomUUID()}`;
    fs.writeFileSync('.ci-runtime-container',name);
    try {
      run('docker',['create','--name',name,'--network','none','--entrypoint','/ci-runtime',image,...check.args]);
      run('docker',['cp',file,`${name}:/ci-runtime`]);
      run('docker',['start','--attach',name]);
      const status=Number(capture('docker',['inspect',name,'--format','{{.State.ExitCode}}']));
      if(status!==0)throw new Error(`release binary failed in runtime image: ${check.asset} (${status})`);
    } finally {cleanupRuntime(false);}
  }
  } finally {cleanupRuntime();}
}
export function cleanupRuntime(removeImage=true) {
  if(fs.existsSync('.ci-runtime-container')) {
    const name=fs.readFileSync('.ci-runtime-container','utf8');
    if(!/^ci-runtime-[0-9a-f-]{36}$/.test(name))throw new Error('invalid runtime container ownership');
    if(capture('docker',['ps','-aq','--filter',`name=^${name}$`]))run('docker',['rm','--force',name]);
    fs.unlinkSync('.ci-runtime-container');
  }
  if(removeImage && fs.existsSync('.ci-runtime-image')) {
    const image=fs.readFileSync('.ci-runtime-image','utf8');
    if(!/^ci-release-runtime-[0-9a-f-]{36}:check$/.test(image))throw new Error('invalid runtime image ownership');
    if(capture('docker',['image','ls','-q',image]))run('docker',['image','rm',image]);
    fs.unlinkSync('.ci-runtime-image');
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='publish')await publishJoinedImage();
  else if(process.argv[2]==='check')await checkJoinedImage();
  else if(process.argv[2]==='cleanup')cleanupRuntime();
  else throw new Error('image.mjs check|publish|cleanup');
}
