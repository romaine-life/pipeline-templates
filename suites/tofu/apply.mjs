import {requirePublish} from '../lib.mjs';
import {init, tofu} from './common.mjs';
requirePublish();
init();
tofu(['apply', '-auto-approve', '-input=false', '-lock-timeout=0s', '-parallelism=4']);
