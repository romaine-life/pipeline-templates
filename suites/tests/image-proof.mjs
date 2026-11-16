import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {api,capture,run,request,output} from '../lib.mjs';
import {watchHealth,ownerLabel} from '../services.mjs';
import {imageFingerprint} from '../image-inputs.mjs';
import {buildImage,pushImage} from '../cluster-service/docker.mjs';
import {publishJoinedImage,checkJoinedImage,cleanupRuntime} from '../release/image.mjs';
import {reserve,stagePart,finalize} from '../release/protocol.mjs';
import {updatePin} from '../cluster-service/pin-fields.mjs';
const registryImage='artifacts.home.romaine.life/dockerhub/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';
const base='artifacts.home.romaine.life/dockerhub/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2';
export async function cleanup(file) {
  if(!file || !fs.existsSync(file))return;
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!/^ci-services-[0-9a-f-]{36}$/.test(state.id) || !/^ci-image-proof-\d+-\d+$/.test(state.prefix))throw new Error('invalid image proof ownership');
  for(const tag of state.tags) {
    if(!tag.startsWith(`${state.prefix}-`))throw new Error('invalid image proof tag');
    const release=await request(`${api()}/releases/tags/${tag}`,{allow404:true});
    if(release){if(release.target_commitish!==state.sha)throw new Error('image proof release source changed');await request(`${api()}/releases/${release.id}`,{method:'DELETE'});}
    await request(`${api()}/tags/${tag}`,{method:'DELETE',allow404:true});
    await request(`${api()}/statuses/${state.sha}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:state.passed?'success':'skipped',context:`Release assets/${tag}`,description:'Image publication proof cleaned up'})});
  }
  if(capture('docker',['ps','-aq','--filter',`name=^${state.id}-registry$`]))run('docker',['rm','-fv',`${state.id}-registry`]);
  if(fs.existsSync(state.root)){const cwd=process.cwd();try {process.chdir(state.root);cleanupRuntime();}finally{process.chdir(cwd);}}
  for(const image of new Set(state.images || [])) {
    if(!image.startsWith(`ci-image-proof-${state.id}:`) && !/^127\.0\.0\.1:\d+\/image-proof:ci-image-proof-\d+-\d+-\d+$/.test(image))throw new Error('invalid proof image ownership');
    if(capture('docker',['image','ls','-q',image]))run('docker',['image','rm',image]);
  }
  fs.rmSync(state.root,{recursive:true,force:true});
}
if(process.argv[2]==='cleanup')await cleanup(process.env.CI_IMAGE_PROOF_STATE);
else {
  const cwd=process.cwd(),root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'image-proof-'));
  const state={root,id:`ci-services-${randomUUID()}`,prefix:`ci-image-proof-${process.env.GITHUB_RUN_NUMBER}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`,sha:capture('git',['rev-parse','HEAD']),tags:[],images:[]},file=path.join(root,'owned.json');
  const save=()=>fs.writeFileSync(file,JSON.stringify(state));save();output('state',file);
  let monitor;
  try {
    monitor=await watchHealth(state.id,['registry']);
    run('docker',['run','-d','--name',`${state.id}-registry`,'--label',`${ownerLabel}=${state.id}`,'-p','127.0.0.1::5000','--health-cmd','wget -qO- http://127.0.0.1:5000/v2/','--health-interval','1s','--health-retries','30',registryImage]);
    await monitor.ready;monitor.close();
    const port=JSON.parse(capture('docker',['inspect',`${state.id}-registry`]))[0].NetworkSettings.Ports['5000/tcp'][0].HostPort;
    const image=`127.0.0.1:${port}/image-proof`;
    process.chdir(root);fs.mkdirSync('k8s/image',{recursive:true});fs.mkdirSync('dist');
    fs.writeFileSync('Dockerfile','This upstream Dockerfile must never be read or built.\n');
    fs.writeFileSync('k8s/image/Dockerfile',`FROM ${base}\nCOPY runtime.conf /runtime.conf\nENTRYPOINT ["/bin/false"]\n`);
    fs.writeFileSync('k8s/image/runtime.conf','runtime v1\n');
    fs.writeFileSync('program.c','int main(void) { return 0; }\n');
    fs.writeFileSync('.gitignore','dist/\nowned.json\n.ci-*\nparts/\n');
    run('git',['init','--initial-branch=main']);run('git',['remote','add','origin',root]);run('git',['config','user.name','image-proof']);run('git',['config','user.email','image-proof@noreply.romaine.life']);
    const commit=()=>{run('git',['add','.']);run('git',['commit','-m','proof inputs']);return capture('git',['rev-parse','HEAD']);};
    commit();
    const cfg={version:1,release:{toolchains:['go'],image:'cluster',runtimeChecks:[{asset:'program',args:['--version']}]},cluster:{image,dockerfile:'k8s/image/Dockerfile',context:'k8s/image',pinFile:'k8s/values.yaml',pinFields:{'release.tag':'tag','release.commit':'commit'}}};
    fs.writeFileSync('.ci.json',JSON.stringify(cfg));
    Object.assign(process.env,{SOURCE_SHA:state.sha,GITHUB_SHA:state.sha,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main'});
    let pushes=0;
    const publish=async(section,mode,login,fingerprint)=>{
      assert.equal(mode,'publish');const local=`ci-image-proof-${state.id}:build`;
      const remote=`${image}:${process.env.VERSION}`;state.images.push(local,remote);save();buildImage(section,local,fingerprint);pushImage(local,remote);pushes++;
    };
    async function release(number,publishImage) {
      const tag=`${state.prefix}-${number}`;state.tags.push(tag);save();process.env.VERSION=tag;
      run('cc',['program.c','-o','dist/program']);
      await publishImage();await reserve();await stagePart('local',fs.readdirSync('dist').map(name=>`dist/${name}`));assert.equal(await finalize(),true);
      const rel=await request(`${api()}/releases/tags/${tag}`);
      await request(`${api()}/releases/${rel.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})});
      return tag;
    }
    const first=await release(1,async()=>{await publish(cfg.cluster,'publish',null,imageFingerprint(cfg,'cluster'));cfg.cluster.imageSource=capture('git',['rev-parse','HEAD']);fs.writeFileSync('k8s/values.yaml',`image: ${fs.readFileSync('.ci-image-pin','utf8')}\nrelease:\n  tag: initial\n  commit: ${state.sha}\n`);assert.equal((await publishJoinedImage(cfg,publish)).published,false);});
    const originalPin=fs.readFileSync('.ci-image-pin','utf8');
    const values=`image: ${originalPin}\nrelease:\n  tag: ${first}\n  commit: ${state.sha}\n`;
    fs.writeFileSync('k8s/values.yaml',values);commit();
    fs.writeFileSync('program.c','int main(void) { return 0; } /* source-only release */\n');const sourceCommit=commit();
    const second=await release(2,async()=>{const result=await publishJoinedImage(cfg,publish);assert.equal(result.published,false);assert.equal(result.pin,originalPin);});
    assert.equal(pushes,1);
    const pinOnly=updatePin(values,cfg.cluster,fs.readFileSync('.ci-image-pin','utf8'),{tag:second,commit:sourceCommit});
    assert.equal(pinOnly,values.replace(`  tag: ${first}\n`,`  tag: ${second}\n`).replace(`  commit: ${state.sha}\n`,`  commit: ${sourceCommit}\n`));
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/v2/image-proof/tags/list`)).json()).tags.includes(second),false);
    console.log('PASS source-only: real release assets published, no image tag/push/build, only release tag/commit changed');
    await checkJoinedImage(cfg);
    run('docker',['run','--rm','--entrypoint','/bin/sh',originalPin,'-ec','test ! -e /ci-runtime && test ! -e /program']);
    console.log('PASS runtime: dynamically linked C binary copied into disposable runtime container; published image contains no binary');
    fs.writeFileSync('k8s/image/runtime.conf','runtime v2\n');commit();
    await release(3,async()=>{const result=await publishJoinedImage(cfg,publish);assert.equal(result.published,true);assert.notEqual(result.pin,originalPin);});
    assert.equal(pushes,2);
    console.log('PASS image input: changed context COPY source built and pushed a new image with a new digest');
    state.passed=true;save();
  } finally {monitor?.close();process.chdir(cwd);await cleanup(file);}
}
