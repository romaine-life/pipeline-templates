import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.mjs';
import {capture, run, requirePublish} from '../lib.mjs';

const image='artifacts.home.romaine.life/mcr/appsvc/staticappsclient:stable@sha256:026b202feacf67ec0acd4846a1d17953f6c3c8ff912a1c0ec29aa6000a495f12';
export function deployStatic(cfg=config().web, execute=run, read=capture) {
  requirePublish();
  const packages=cfg.packages || ['.'];
  if (packages.length!==1 || !cfg.staticApp || !cfg.resourceGroup) throw new Error('Static Web App needs one package, staticApp and resourceGroup');
  const source=path.resolve(packages[0],'dist');
  if (!fs.existsSync(path.join(source,'index.html'))) throw new Error('Static Web App build must produce dist/index.html');
  const token=read('az',['staticwebapp','secrets','list','--name',cfg.staticApp,'--resource-group',cfg.resourceGroup,'--query','properties.apiKey','-o','tsv']);
  if (!token || /\r|\n/.test(token)) throw new Error('invalid Static Web App deployment token');
  const container=read('docker',['create','-e','INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN','-e','INPUT_APP_LOCATION=/workspace/site','-e','INPUT_SKIP_APP_BUILD=true','-e','GITHUB_WORKSPACE=/workspace','--workdir','/workspace','--entrypoint','/bin/staticsites/StaticSitesClient',image,'upload'],{env:{...process.env,INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN:token}});
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('invalid deployment container ID');
  try {
    execute('docker',['cp',source,`${container}:/workspace/site`]);
    execute('docker',['start','--attach',container]);
    if (read('docker',['inspect','--format','{{.State.ExitCode}}',container])!=='0') throw new Error('Static Web App upload failed');
  } finally {execute('docker',['rm','-f',container]);}
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) deployStatic();
