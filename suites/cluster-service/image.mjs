import fs from 'node:fs';
import {run, capture, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

export async function imageOperation(cfg, mode, login) {
const repo = (process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-');
const image = `ci-${repo}:${process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD'])}`;
if (!['check', 'publish'].includes(mode)) throw new Error('image.mjs check|publish');
if (mode === 'publish') requirePublish();
const build = cfg.build !== false;
if (build) {
  run('docker', ['build', '--network', 'host', '-t', image, '.'], {env: {...process.env, DOCKER_BUILDKIT: '1'}});
} else if (!cfg.image) throw new Error('upstream service requires cluster.image pinned by digest');
if (mode === 'check') {
  // The application self-test must exit, including database migrations and sign-in assertions.
  run('docker', ['run', '--rm', '--network', process.env.CI_SERVICE_NETWORK || 'host', '--read-only',
    ...['DATABASE_URL','MANTICORE_URL','SMTP_HOST','SMTP_PORT','IMAP_HOST','IMAP_PORT'].filter(k=>process.env[k]).flatMap(k=>['-e',k]), build ? image : cfg.image, '--self-test']);
} else if (build) {
  const {registryLogin} = await import('./registry.mjs');
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'registry-'));
  const old = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = temp;
  try {
    await (login || registryLogin)(cfg);
    const remote = `${cfg.image}:${process.env.VERSION}`;
    if (!cfg.image || !/^(?:forgejo\.romaine\.life|[a-z0-9]+\.azurecr\.io)\/[\w./-]+$/.test(cfg.image)) throw new Error('image must name the Forgejo registry or ACR repository');
    run('docker', ['tag', image, remote]);
    run('docker', ['push', remote]);
    const digest = JSON.parse(capture('docker', ['image', 'inspect', remote, '--format', '{{json .RepoDigests}}']));
    const pin = digest.find(d => d.startsWith(`${cfg.image}@`));
    if (!pin || !/@sha256:[0-9a-f]{64}$/.test(pin)) throw new Error('push produced no registry digest');
    fs.writeFileSync('.ci-image-pin', `${cfg.image}:${process.env.VERSION}@${pin.split('@')[1]}`);
  } finally {
    if (old === undefined) delete process.env.DOCKER_CONFIG; else process.env.DOCKER_CONFIG = old;
    fs.rmSync(temp, {recursive: true, force: true});
  }
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await imageOperation(config().cluster || {}, process.argv[2]);
