import fs from 'node:fs';
import {capture, run, requirePublish} from '../lib.mjs';
import {proposeDependencies} from '../deps-pr.mjs';
import {ownRequires, prefix} from './modules.mjs';
requirePublish();
// Every github.com/romaine-life/ module go.mod requires (go/modules.mjs).
const modules = fs.existsSync('go.mod') ? ownRequires(fs.readFileSync('go.mod', 'utf8')) : [];
if (!modules.length) { console.log(`go.mod requires no ${prefix} module`); process.exit(0); }
const token=process.env.TOKEN;
if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN');
const env = {...process.env, GOPRIVATE: `${prefix}*`, GONOSUMDB: `${prefix}*`,
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${process.env.GITHUB_SERVER_URL}/romaine-life/.insteadOf`,
  GIT_CONFIG_VALUE_0: `https://${prefix}`,
  GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
run('go', ['get', '-p', '4', ...modules.map(m => `${m}@latest`)], {env});
run('go', ['mod', 'tidy'], {env});
if (capture('git', ['diff', '--name-only', '--', 'go.mod', 'go.sum'])) {
  await proposeDependencies({files: ['go.mod', 'go.sum'], title: 'Take Go dependencies', message: `Take ${modules.join(', ')}`,
    summary: `Updated ${modules.join(', ')}.`, token, env});
}
