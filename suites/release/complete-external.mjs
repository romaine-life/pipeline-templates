import fs from 'node:fs';
import path from 'node:path';
import {api, post, request} from '../lib.mjs';
import {packageAssets} from './assets.mjs';
import {stagePart} from './protocol.mjs';
export async function completeExternal() {
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
