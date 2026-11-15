import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export async function dockerEvents(filters,onEvent,onError,signal) {
  const host=process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  const tls=!!process.env.DOCKER_TLS_VERIFY;
  const endpoint=host.startsWith('unix://') ? 'http://localhost' : host.replace(/^tcp:/,tls?'https:':'http:');
  const options={signal,...(host.startsWith('unix://') ? {socketPath:host.slice(7)} : {})};
  if(tls)for(const [key,file]of [['ca','ca.pem'],['cert','cert.pem'],['key','key.pem']])options[key]=fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH,file));
  let request,response,closed=false,buffered='';
  const close=()=>{closed=true;response?.destroy();request?.destroy();};
  try {
    response=await new Promise((resolve,reject)=>{
      request=(tls?https:http).get(endpoint+'/events?filters='+encodeURIComponent(JSON.stringify(filters)),options,resolve);
      request.on('error',error=>{reject(error);if(response && !closed)onError(error);});
    });
    if(response.statusCode!==200)throw new Error(`Docker events HTTP ${response.statusCode}`);
    response.on('error',error=>{if(!closed)onError(error);});
    response.on('end',()=>{if(!closed)onError(new Error('Docker event stream ended before readiness'));});
    response.on('data',chunk=>{
      buffered+=chunk;
      let end;
      while((end=buffered.indexOf('\n'))>=0) {
        const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
        try {if(line)onEvent(JSON.parse(line));}
        catch(error){onError(error);close();return;}
      }
    });
    return {close};
  } catch(error){close();throw error;}
}
