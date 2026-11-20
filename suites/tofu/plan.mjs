import {init, tofu} from './common.mjs';
init();
tofu(['fmt', '-recursive', '-check']);
tofu(['validate']);
// A pull request's plan writes no state, so it takes no lock: a newer push cancels the
// running plan (the suite's concurrency group), and a plan killed holding the lock left
// it held, failing every later plan and apply until it was broken by hand (BAO-15).
tofu(['plan', '-input=false', '-lock=false', '-parallelism=4', '-out=tfplan']);
