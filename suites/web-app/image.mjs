import {config} from '../config.mjs';
import {run} from '../lib.mjs';
import {imageOperation} from '../cluster-service/image.mjs';
const cfg = config().web || {};
await imageOperation(cfg, process.argv[2], async () => {
  run('az',['acr','login','--name',cfg.image.split('.')[0]]);
}, {workflow: 'web-app/ci.yml', published: true});
