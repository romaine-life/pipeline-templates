import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import {capture,run} from '../lib.mjs';
import {startServices,probeService,ownerLabel,stateFile} from '../services.mjs';
const images=JSON.parse(fs.readFileSync(new URL('./service-images.json',import.meta.url),'utf8'));
const env=await startServices(images);
const state=JSON.parse(fs.readFileSync(stateFile(),'utf8'));
const pair=process.env.CI_SERVICE_PAIR,slot=process.env.CI_SERVICE_SLOT;
assert.match(pair,/^[0-9]+-[0-9]+$/);assert.ok(['one','two'].includes(slot));
const ready=new Set(),host=process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
const tls=!!process.env.DOCKER_TLS_VERIFY,endpoint=host.startsWith('unix://') ? 'http://localhost' : host.replace(/^tcp:/,tls?'https:':'http:');
const options=host.startsWith('unix://') ? {socketPath:host.slice(7)} : {};
if(tls)for(const [key,file]of [['ca','ca.pem'],['cert','cert.pem'],['key','key.pem']])options[key]=fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH,file));
let request,response,timer,buffered='';
try {
  response=await new Promise((resolve,reject)=>{
    request=(tls?https:http).get(endpoint+'/events?filters='+encodeURIComponent(JSON.stringify({type:['network'],event:['create']})),options,resolve);
    request.on('error',reject);request.setTimeout(300000,()=>request.destroy(new Error('Docker event stream timed out')));
  });
  assert.equal(response.statusCode,200);
  const overlap=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('second service job did not reach readiness')),300000);
    const observe=name=>{
      for(const peer of ['one','two'])if(name?.endsWith(`-ready-${pair}-${peer}`))ready.add(peer);
      if(ready.has('one') && ready.has('two'))resolve();
    };
    response.on('error',reject);
    response.on('data',chunk=>{
      buffered+=chunk;
      while(buffered.includes('\n')) {
        const end=buffered.indexOf('\n'),line=buffered.slice(0,end);buffered=buffered.slice(end+1);
        try{observe(JSON.parse(line).Actor.Attributes.name);}catch(error){reject(error);}
      }
    });
    for(const name of capture('docker',['network','ls','--filter',`label=life.romaine.ci.pair=${pair}`,'--format','{{.Name}}']).split('\n'))observe(name);
    run('docker',['network','create','--label',`${ownerLabel}=${state.id}`,'--label',`life.romaine.ci.pair=${pair}`,`${state.id}-ready-${pair}-${slot}`]);
    observe(`${state.id}-ready-${pair}-${slot}`);
  });
  await overlap;
  await Promise.all(Object.entries(state.addresses).map(([name,address])=>probeService(name,address)));
  assert.equal(new Set(Object.values(state.addresses)).size,3);
  console.log(`Concurrent TCP proof: ${slot}, network ${env.CI_SERVICE_NETWORK}, ${JSON.stringify(state.addresses)}`);
} finally {clearTimeout(timer);response?.destroy();request?.destroy();}
