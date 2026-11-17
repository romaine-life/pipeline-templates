import {capture, run, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import {proposeDependencies} from '../deps-pr.mjs';
requirePublish();
const modules = config().go?.dependencies || [];
if (!modules.length || modules.some(m => !/^github\.com\/romaine-life\/[\w.-]+(?:\/[\w.-]+)*$/.test(m))) throw new Error('go.dependencies must name romaine-life modules');
const token=process.env.TOKEN;
if (!token) throw new Error('missing PIPELINE_DISPATCH_TOKEN');
const env = {...process.env, GOPRIVATE: 'github.com/romaine-life/*', GONOSUMDB: 'github.com/romaine-life/*',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${process.env.GITHUB_SERVER_URL}/romaine-life/.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/romaine-life/',
  GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`};
run('go', ['get', '-p', '4', ...modules.map(m => `${m}@latest`)], {env});
run('go', ['mod', 'tidy'], {env});
if (capture('git', ['diff', '--name-only', '--', 'go.mod', 'go.sum'])) {
  await proposeDependencies({files: ['go.mod', 'go.sum'], title: 'Take Go dependencies', message: `Take ${modules.join(', ')}`,
    summary: `Updated ${modules.join(', ')}.`, token, env});
}
