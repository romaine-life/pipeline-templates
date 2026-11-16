import {buildImage,pushImage} from './docker.mjs';
import fs from 'node:fs';
import {run, capture, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

export async function imageOperation(cfg, mode, login, fingerprint) {
const repo = (process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-');
const image = `ci-${repo}:${process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD'])}`;
if (!['check', 'publish'].includes(mode)) throw new Error('image.mjs check|publish');
if (mode === 'publish') requirePublish();
const build = cfg.build !== false;
if (build) {
  buildImage(cfg,image,fingerprint);
} else if (!cfg.image) throw new Error('upstream service requires cluster.image pinned by digest');
if (mode === 'check') {
  // The application self-test must exit, including database migrations and sign-in assertions.
  run('docker', ['run', '--rm', '--network', process.env.CI_SERVICE_NETWORK || 'host', '--read-only',
    ...['DATABASE_URL','MANTICORE_URL','SMTP_HOST','SMTP_PORT','IMAP_HOST','IMAP_PORT'].filter(k=>process.env[k]).flatMap(k=>['-e',k]), build ? image : cfg.image, '--self-test']);
} else if (build) {
  await withRegistry(cfg,login,async()=>{
    const remote = `${cfg.image}:${process.env.VERSION}`;
    if (!cfg.image || !/^(?:forgejo\.romaine\.life|[a-z0-9]+\.azurecr\.io)\/[\w./-]+$/.test(cfg.image)) throw new Error('image must name the Forgejo registry or ACR repository');
    pushImage(image,remote);
  });
}
}
export async function withRegistry(cfg,login,operation) {
  const {registryLogin}=await import('./registry.mjs');
  const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'registry-')),old=process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG=temp;
  try {await (login || registryLogin)(cfg);return await operation();}
  finally {if(old===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=old;fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await imageOperation(config().cluster || {},process.argv[2]);
