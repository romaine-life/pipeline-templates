import {run} from '../lib.mjs';
import {jobToken} from '../packages.mjs';

// The audience of nelson's Forgejo integration ci-image-publish (nelsong6/forgejo README,
// Package sign-in): it takes this job's own short-lived token as `docker login`'s password,
// for a suite's publish from main or master, on a push or dispatch, and may write packages.
// No registry credential is stored (BAO-15).
export const imagePublishAudience = 'u:1:cd5766fe-554a-40dc-93a5-d8d6e441c444';

const login = token => run('docker', ['login', 'forgejo.romaine.life', '--username', 'nelson', '--password-stdin'],
  {input: token, stdio: ['pipe', 'inherit', 'inherit']});

export async function registryLogin(cfg) {
  try {
    login(await jobToken(imagePublishAudience));
    console.log('signed in to forgejo.romaine.life with this job\'s own token (ci-image-publish)');
    return;
  } catch (err) {
    // Until each publish has signed in this way once, the stored token is the fallback, and
    // the log says so; then it and the stored registry tokens go (BAO-15).
    console.log(`::warning::the job's own token didn't sign in to forgejo.romaine.life (${err.message}); using the stored registry token`);
  }
  await storedLogin(cfg);
}

async function storedLogin(cfg) {
  const response = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=openbao`, {
    headers: {Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`OIDC: HTTP ${response.status}`);
  const {value: jwt} = await response.json();
  const signin = await fetch('https://bao.home.romaine.life/v1/auth/forgejo/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({role: cfg.baoRole, jwt}), signal: AbortSignal.timeout(30000)});
  if (!signin.ok) throw new Error(`OpenBao sign-in: HTTP ${signin.status}`);
  const {auth} = await signin.json();
  try {
    const secret = await fetch(`https://bao.home.romaine.life/v1/secret/data/${cfg.baoSecret}`, {
      headers: {'X-Vault-Token': auth.client_token}, signal: AbortSignal.timeout(30000)});
    if (!secret.ok) throw new Error(`OpenBao registry read: HTTP ${secret.status}`);
    const {data} = await secret.json();
    const token = data.data['registry-token'];
    if (!token) throw new Error('OpenBao secret has no registry-token');
    login(token);
  } finally {
    const revoke = await fetch('https://bao.home.romaine.life/v1/auth/token/revoke-self', {method: 'POST',
      headers: {'X-Vault-Token': auth.client_token}, signal: AbortSignal.timeout(30000)});
    if (!revoke.ok) throw new Error(`OpenBao revoke: HTTP ${revoke.status}`);
  }
}
