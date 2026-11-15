import fs from 'node:fs';
export function goEnvironment() {
  const requirements=fs.readFileSync('go.mod','utf8').split(/\r?\n/).filter(line=>!line.startsWith('module ')).join('\n');
  if (!requirements.includes('github.com/romaine-life/')) return;
  const server=(process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life').replace(/\/$/,'');
  const env={GOPRIVATE:'github.com/romaine-life/*',GONOSUMDB:'github.com/romaine-life/*',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`url.${server}/romaine-life/.insteadOf`,GIT_CONFIG_VALUE_0:'https://github.com/romaine-life/'};
  if (process.env.PRIVATE_GO_TOKEN) Object.assign(env,{GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_1:`http.${server}/romaine-life/.extraheader`,GIT_CONFIG_VALUE_1:`Authorization: Basic ${Buffer.from(`x-access-token:${process.env.PRIVATE_GO_TOKEN}`).toString('base64')}`});
  Object.assign(process.env,env);
}
