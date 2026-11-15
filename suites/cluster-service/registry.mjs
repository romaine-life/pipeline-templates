import {run} from '../lib.mjs';
export async function registryLogin(cfg) {
  const response = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=openbao`, {
    headers: {Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`OIDC: HTTP ${response.status}`);
  const {value: jwt} = await response.json();
  const login = await fetch('https://bao.home.romaine.life/v1/auth/forgejo/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({role: cfg.baoRole, jwt}), signal: AbortSignal.timeout(30000)});
  if (!login.ok) throw new Error(`OpenBao sign-in: HTTP ${login.status}`);
  const {auth} = await login.json();
  try {
    const secret = await fetch(`https://bao.home.romaine.life/v1/secret/data/${cfg.baoSecret}`, {
      headers: {'X-Vault-Token': auth.client_token}, signal: AbortSignal.timeout(30000)});
    if (!secret.ok) throw new Error(`OpenBao registry read: HTTP ${secret.status}`);
    const {data} = await secret.json();
    const token = data.data['registry-token'];
    if (!token) throw new Error('OpenBao secret has no registry-token');
    run('docker', ['login', 'forgejo.romaine.life', '--username', 'nelson', '--password-stdin'], {input: token, stdio: ['pipe', 'inherit', 'inherit']});
  } finally {
    const revoke = await fetch('https://bao.home.romaine.life/v1/auth/token/revoke-self', {method: 'POST',
      headers: {'X-Vault-Token': auth.client_token}, signal: AbortSignal.timeout(30000)});
    if (!revoke.ok) throw new Error(`OpenBao revoke: HTTP ${revoke.status}`);
  }
}
