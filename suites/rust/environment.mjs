import fs from 'node:fs';

// A git dependency on Forgejo (a `git+https://forgejo.romaine.life/...` source in Cargo.lock):
// Forgejo asks for a sign-in even to read, so cargo fetches it through git with the pipeline's
// token. Nothing changes for a crate whose dependencies all come from the registry.
export function rustEnvironment(token = process.env.PRIVATE_GIT_TOKEN, lock = fs.existsSync('Cargo.lock') ? fs.readFileSync('Cargo.lock', 'utf8') : '') {
  const server = (process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life').replace(/\/$/, '');
  if (!lock.includes(`source = "git+${server}/`)) return {};
  if (!token) throw new Error('a Forgejo git dependency needs PRIVATE_GIT_TOKEN');
  const env = {CARGO_NET_GIT_FETCH_WITH_CLI: 'true', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
  Object.assign(process.env, env);
  return env;
}
