import {run} from '../lib.mjs';
import {jobToken} from '../packages.mjs';

// The audience of nelson's Forgejo integration ci-image-publish (nelsong6/forgejo README,
// Package sign-in): it takes this job's own short-lived token as `docker login`'s password,
// for a suite's publish from main or master, on a push or dispatch, and may write packages.
// No registry credential is stored (BAO-15).
export const imagePublishAudience = 'u:1:cd5766fe-554a-40dc-93a5-d8d6e441c444';

export async function registryLogin() {
  run('docker', ['login', 'forgejo.romaine.life', '--username', 'nelson', '--password-stdin'],
    {input: await jobToken(imagePublishAudience), stdio: ['pipe', 'inherit', 'inherit']});
  console.log("signed in to forgejo.romaine.life with this job's own token (ci-image-publish)");
}
