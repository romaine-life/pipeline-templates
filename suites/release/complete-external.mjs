import fs from 'node:fs';
import path from 'node:path';
import {api, output, post, request} from '../lib.mjs';
import {packageAssets} from './assets.mjs';
import {stagePart} from './protocol.mjs';
import {config} from '../config.mjs';
import {releasePlan} from './plan.mjs';
import {artifactName,attest,externalFingerprint} from './prior-build.mjs';
// An external part's build hands its dist/ here. Dispatched by a release, the files go to the
// draft it reserved and the release suite is called back. On a pull request they are packaged
// the same way and the part's fingerprint, with the tag the build stamped (release-version's
// next), is attested in this job's log; the workflow then keeps dist/ as the run's artifact,
// named by this step's artifact output, and the merge that reserves that tag with the same
// inputs publishes those files instead of dispatching the build again (prior-build.mjs).
export function keepForMerge({cfg=config(),plan=releasePlan(cfg)}={}) {
  // A repository has one external part (topics.mjs), so a pull request's build needn't name it.
  const part=process.env.PART_ID ? plan.external.find(p=>p.id===process.env.PART_ID) : plan.external.length===1 ? plan.external[0] : null;
  if(!part)throw new Error(`no release part ${process.env.PART_ID || ''} is this repository's external build`);
  packageAssets({kind:'external'});
  attest(externalFingerprint({cfg,part,version:process.env.VERSION}));
  output('artifact',artifactName(part.id));
}
export async function completeExternal() {
if (process.env.GITHUB_EVENT_NAME==='pull_request') return keepForMerge();
if (!process.env.RELEASE_SERVER_URL || !process.env.RELEASE_REPOSITORY || !process.env.SOURCE_SHA || !process.env.PART_ID) throw new Error('external completion requires Forgejo destination, source SHA and part id');
process.env.GITHUB_SERVER_URL=process.env.RELEASE_SERVER_URL;
process.env.GITHUB_REPOSITORY=process.env.RELEASE_REPOSITORY;
const completion=process.env.COMPLETION || 'success';
if(completion==='success')packageAssets({kind:'external',part:process.env.PART_ID});
const receipt=completion==='success' ? await stagePart(process.env.PART_ID,fs.readdirSync('dist').map(f=>path.join('dist',f)),{deferReceipt:true}) : undefined;
const repo=await request(api());
await post(`${api()}/actions/workflows/release%2Fci.yml/dispatches`,{ref:repo.default_branch,inputs:{'release-tag':process.env.VERSION,'source-sha':process.env.SOURCE_SHA,'completed-part':process.env.PART_ID,completion,receipt:receipt?JSON.stringify(receipt):''}});
}
if (process.argv[1]?.endsWith('complete-external.mjs')) await completeExternal();
