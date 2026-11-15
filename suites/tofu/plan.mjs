import {init, tofu} from './common.mjs';
init();
tofu(['fmt', '-recursive', '-check']);
tofu(['validate']);
tofu(['plan', '-input=false', '-lock-timeout=0s', '-parallelism=4', '-out=tfplan']);
