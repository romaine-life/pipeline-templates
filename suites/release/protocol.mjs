import fs from 'node:fs';
import path from 'node:path';
import {api, hash, output, post, request, requirePublish} from '../lib.mjs';
import {metadataFiles} from './metadata.mjs';
import {releasePlan} from './plan.mjs';

const prefix='<!-- ci-release-v2\n';
const tag=()=>{if (!/^[\w.+-]+$/.test(process.env.VERSION || '')) throw new Error('invalid reserved release tag');return process.env.VERSION;};
const source=()=>process.env.SOURCE_SHA || process.env.GITHUB_SHA;
const header=()=>`Joined release from ${source()}.`;
const body=value=>`${header()}\n\n${prefix}${JSON.stringify(value)}\n-->`;
const release=()=>request(`${api()}/releases/tags/${encodeURIComponent(tag())}`,{allow404:true});
function state(rel,{tagName=tag(),sha=source()}={}) {
  if(!rel)throw new Error('reserved draft release does not exist');
  const start=rel.body?.indexOf(prefix),end=rel.body?.lastIndexOf('\n-->');
  if(start<0 || end<start)throw new Error('reserved draft has no API-readable release plan; retry reserve first');
  const value=JSON.parse(rel.body.slice(start+prefix.length,end));
  if(value.plan?.version!==1 || value.plan.tag!==tagName || value.plan.sha!==sha || !/^[0-9a-f]{40,64}$/.test(value.plan.sha))throw new Error('release receipt tag or source SHA differs from the reserved draft');
  return value;
}
async function save(rel,value) {
  if(!rel.draft)throw new Error('published releases are immutable');
  return request(`${api()}/releases/${rel.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:body(value)})});
}
async function upload(rel,name,bytes) {
  if(!rel.draft)throw new Error('published releases are immutable');
  const old=rel.assets?.find(a=>a.name===name);
  if(old)await request(`${api()}/releases/${rel.id}/assets/${old.id}`,{method:'DELETE'});
  const form=new FormData();form.append('attachment',new Blob([bytes]),name);
  const asset=await request(`${api()}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',body:form});
  if(!Number.isSafeInteger(asset.id) || asset.size!==bytes.length || asset.name!==name)throw new Error('uploaded attachment acknowledgment differs from its bytes');
  return asset;
}
async function status(value,state,description) {
  await post(`${api()}/statuses/${value.sha}`,{state,context:`Release assets/${value.tag}`,description});
}
export async function reserve() {
  requirePublish();
  const plan={version:1,tag:tag(),sha:source(),...releasePlan()};
  let rel=await release(),value;
  if(rel) {
    if(!rel.body?.includes(prefix)) {
      if(!rel.draft || rel.body!==header() || rel.target_commitish!==source() || rel.assets?.some(a=>a.name!=='ci-release-plan.json'))throw new Error('cannot recover an unrecognized legacy draft');
      value={plan,receipts:{},requests:{}};
      await save(rel,value);
    } else {
      value=state(rel);
      if(JSON.stringify(value.plan)!==JSON.stringify(plan))throw new Error('draft release plan differs from this retry');
      if(!rel.draft){output('published',true);return;}
    }
  } else {
    value={plan,receipts:{},requests:{}};
    rel=await post(`${api()}/releases`,{tag_name:tag(),target_commitish:source(),name:tag(),body:body(value),draft:true,prerelease:true});
  }
  rel=await release();
  for(const asset of rel.assets || [])if(asset.name==='ci-release-plan.json')await request(`${api()}/releases/${rel.id}/assets/${asset.id}`,{method:'DELETE',allow404:true});
  await status(plan,'pending','Building the declared release parts');
  for(const part of plan.external) {
    if(value.requests[part.id] || value.receipts[part.id])continue;
    const forgejo=part.provider==='forgejo',token=forgejo?process.env.DISPATCH_TOKEN:process.env.GITHUB_DISPATCH_TOKEN;
    if(!token)throw new Error('external release build needs its dispatch token');
    const remote=forgejo?`${process.env.GITHUB_SERVER_URL}/api/v1/repos/${part.repository}`:`https://api.github.com/repos/${part.repository}`;
    const repo=await request(remote,{token});
    await post(`${remote}/actions/workflows/${encodeURIComponent(part.workflow)}/dispatches`,{ref:repo.default_branch,inputs:{release_tag:tag(),source_sha:source(),release_repository:process.env.GITHUB_REPOSITORY,part_id:part.id,callback_workflow:'release/ci.yml',suites_ref:process.env.SUITES_REF || 'main'}},{token});
    value.requests[part.id]=true;await save(rel,value);
  }
  output('published',false);
}
function verifyReceipt(rel,value,receipt) {
  const plan=value.plan,id=receipt.id;
  if(receipt.version!==2 || receipt.sha!==plan.sha || receipt.tag!==plan.tag || !receipt.files?.length || id==='local' && !plan.local || id!=='local' && id!=='metadata' && !plan.external.some(p=>p.id===id))throw new Error('invalid or undeclared release receipt');
  const expected=['local','metadata'].includes(id)?null:plan.external.find(p=>p.id===id).assets;
  if(expected && JSON.stringify([...expected].sort())!==JSON.stringify(receipt.files.map(f=>f.name).sort()))throw new Error('external receipt has unexpected assets');
  const names=new Set();
  for(const file of receipt.files) {
    const asset=rel.assets?.find(a=>a.id===file.id);
    if(names.has(file.name) || !/^[\w.+-]+$/.test(file.name) || file.name.startsWith('ci-release-') || !/^[0-9a-f]{64}$/.test(file.sha256) || !asset || asset.name!==file.name || asset.size!==file.size || asset.uuid!==file.uuid || asset.type && asset.type!=='attachment')throw new Error(`release asset differs from its receipt: ${file.name}`);
    names.add(file.name);
  }
}
export async function acceptReceipt(receipt) {
  if(receipt.id==='metadata')throw new Error('metadata receipts are owned by finalize');
  const rel=await release(),value=state(rel);
  verifyReceipt(rel,value,receipt);
  const normalized=part=>({version:part.version,sha:part.sha,tag:part.tag,id:part.id,files:[...part.files].sort((a,b)=>a.name.localeCompare(b.name)).map(file=>({name:file.name,size:file.size,sha256:file.sha256,id:file.id,uuid:file.uuid}))});
  const previous=value.receipts[receipt.id];
  if(previous && JSON.stringify(normalized(previous))===JSON.stringify(normalized(receipt)))return;
  value.receipts[receipt.id]=normalized(receipt);await save(rel,value);
}
export async function stagePart(id,files,{deferReceipt=false}={}) {
  const rel=await release(),value=state(rel),plan=value.plan;
  if(!rel.draft)throw new Error('cannot upload a part to a published release');
  if(id==='local' && !plan.local || id!=='local' && !plan.external.some(p=>p.id===id))throw new Error('undeclared external release part');
  if(id!=='local' && !deferReceipt)throw new Error('external receipts must arrive through the serialized Forgejo callback');
  const reserved=new Set(plan.external.flatMap(p=>p.assets)),manifest=[];
  for(const file of files) {
    const name=path.basename(file),size=fs.statSync(file).size;
    if(name.startsWith('ci-release-') || !size || manifest.some(f=>f.name===name))throw new Error('release files must be nonempty, uniquely named assets');
    if(id==='local' && reserved.has(name))throw new Error('local asset collides with a reserved external asset');
    manifest.push({name});
  }
  if(!manifest.length)throw new Error('release part has no assets');
  if(id!=='local' && JSON.stringify([...plan.external.find(p=>p.id===id).assets].sort())!==JSON.stringify(manifest.map(f=>f.name).sort()))throw new Error('external assets differ from the reserved names');
  for(const old of value.receipts[id]?.files || [])if(!manifest.some(f=>f.name===old.name)) {
    const asset=rel.assets.find(a=>a.id===old.id);
    if(asset)await request(`${api()}/releases/${rel.id}/assets/${asset.id}`,{method:'DELETE'});
  }
  for(const [index,file] of files.entries()) {
    const bytes=fs.readFileSync(file);if(!bytes.length)throw new Error('release files must remain nonempty');
    const asset=await upload(rel,manifest[index].name,bytes);
    Object.assign(manifest[index],{id:asset.id,uuid:asset.uuid,size:bytes.length,sha256:hash(bytes)});
  }
  const receipt={version:2,sha:plan.sha,tag:plan.tag,id,files:manifest};
  if(!deferReceipt)await acceptReceipt(receipt);
  return receipt;
}
export async function finalize(completedPart='',completion='success',receipt) {
  requirePublish();
  let rel=await release(),value=state(rel),plan=value.plan;
  if(completedPart && !plan.external.some(p=>p.id===completedPart))throw new Error('callback names an undeclared part');
  if(completion!=='success'){await status(plan,'failure',`Release part ${completedPart} failed`);throw new Error('external release build failed');}
  if(completedPart) {
    if(!receipt || receipt.id!==completedPart)throw new Error('success callback has no uploaded receipt');
    await acceptReceipt(receipt);rel=await release();value=state(rel);
  }
  const missing=[],seen=new Set(),ids=new Set();
  for(const id of [...(plan.local?['local']:[]),...plan.external.map(p=>p.id)]) {
    const part=value.receipts[id];if(!part){missing.push(id);continue;}
    verifyReceipt(rel,value,part);
    for(const file of part.files){if(seen.has(file.name))throw new Error('release part names collide');seen.add(file.name);ids.add(file.id);}
  }
  const ready=!missing.length;
  if(ready) {
    const records=Object.values(value.receipts).flatMap(part=>part.files),generated=metadataFiles(records,plan.metadata || {},{tag:plan.tag,sha:plan.sha});
    const manifest=[];
    for(const [name,bytes] of Object.entries(generated)) {
      const previous=value.generated?.files.find(file=>file.name===name),asset=rel.assets.find(asset=>asset.id===previous?.id);
      if(previous && asset && previous.sha256===hash(bytes) && previous.size===bytes.length && asset.name===name && asset.size===bytes.length && asset.uuid===previous.uuid)manifest.push(previous);
      else {const asset=await upload(rel,name,bytes);manifest.push({name,id:asset.id,uuid:asset.uuid,size:bytes.length,sha256:hash(bytes)});}
    }
    if(manifest.length) {
      const generatedReceipt={version:2,id:'metadata',tag:plan.tag,sha:plan.sha,files:manifest};
      if(JSON.stringify(value.generated)!==JSON.stringify(generatedReceipt)){value.generated=generatedReceipt;await save(rel,value);}
      rel=await release();verifyReceipt(rel,value,value.generated);
      for(const file of manifest)ids.add(file.id);
    }
    if(rel.assets.some(a=>!ids.has(a.id)))throw new Error('draft has assets not covered by a release receipt');
    if(rel.prerelease)await request(`${api()}/releases/${rel.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({prerelease:false})});
  }
  await status(plan,ready?'success':'pending',ready?'Every release asset is complete':`Awaiting release parts: ${missing.join(', ')}`);
  output('ready',ready);output('home-sync',plan.homeSync);output('tag',plan.tag);output('image',plan.image);return ready;
}
export async function materializeAsset(name,destination,previous) {
  const rel=previous || await release(),value=previous ? state(rel,{tagName:rel.tag_name,sha:rel.target_commitish}) : state(rel);
  if(rel.draft)throw new Error('deployment needs a published release');
  const asset=rel.assets.find(a=>a.name===name),receipt=Object.values(value.receipts).flatMap(p=>p.files).find(f=>f.name===name);
  if(!asset || !receipt)throw new Error('release has no declared asset');
  if(new URL(asset.browser_download_url).origin!==new URL(process.env.GITHUB_SERVER_URL).origin)throw new Error('release download must stay on its Forgejo origin');
  const response=await fetch(asset.browser_download_url,{headers:{Authorization:`token ${process.env.TOKEN}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`release asset download: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==receipt.size || hash(bytes)!==receipt.sha256)throw new Error('downloaded release asset differs from its receipt');
  fs.writeFileSync(destination,bytes);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/release/protocol.mjs')) {
  if(process.argv[2]==='reserve')await reserve();
  else if(process.argv[2]==='stage')await stagePart('local',fs.readdirSync('dist').map(f=>path.join('dist',f)));
  else if(process.argv[2]==='finalize')await finalize(process.env.COMPLETED_PART || '',process.env.COMPLETION || 'success',process.env.COMPLETED_RECEIPT?JSON.parse(process.env.COMPLETED_RECEIPT):undefined);
  else throw new Error('protocol.mjs reserve|stage|finalize');
}
