import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {capture,run} from './lib.mjs';
import {config} from './config.mjs';
import {dockerEvents} from './docker-events.mjs';
export const ownerLabel='life.romaine.ci.services';
export const greenmailUsers=['alice:secret@example.com','bob:secret@example.com'];
export const stateFile=()=>path.resolve(process.env.CI_SERVICE_STATE || '.ci-services.json');
const list=text=>text.split(/\r?\n/).filter(Boolean);
function readState() {
  const state=JSON.parse(fs.readFileSync(stateFile(),'utf8'));
  if (!/^ci-services-[0-9a-f-]{36}$/.test(state.id)) throw new Error('invalid service ownership id');
  return state;
}
export function serviceEnvironment(state) {
  const env={CI_SERVICE_NETWORK:state.id};
  if(state.addresses.postgres) env.DATABASE_URL=`postgres://postgres@${state.addresses.postgres}:5432/postgres`;
  if(state.addresses.manticore) env.MANTICORE_URL=`http://${state.addresses.manticore}:9308`;
  if(state.addresses.greenmail) {
    const host=state.addresses.greenmail;
    Object.assign(env,{SMTP_HOST:host,SMTP_PORT:'3025',IMAP_HOST:host,IMAP_PORT:'3143',POP3_HOST:host,POP3_PORT:'3110',
      SMTPS_PORT:'3465',IMAPS_PORT:'3993',POP3S_PORT:'3995'});
    // GreenMail's own certificate, for a client that pins it the way an account trusts its server's.
    if(state.certificate) env.GREENMAIL_CERT=state.certificate;
  }
  return env;
}
export function connection(host,port,onConnect,onData) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host,port});let bytes=Buffer.alloc(0),settled=false;
    const finish=error=>{if(settled)return;settled=true;socket.destroy();error ? reject(error) : resolve();};
    socket.setTimeout(3000,()=>finish(new Error(`${host}:${port} timed out`)));
    socket.on('error',finish);
    socket.on('connect',()=>{try {onConnect(socket,finish);}catch(error){finish(error);}});
    socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);try {onData(bytes,socket,finish);}catch(error){finish(error);}});
    socket.on('close',()=>{if(!settled)finish(new Error(`${host}:${port} closed before readiness`));});
  });
}
// The certificate a TLS port presents, as PEM. Read from the handshake, unverified: it is
// GreenMail's own, on the job's private network, and is what the tests are then given to trust.
export function peerCertificate(host,port) {
  return new Promise((resolve,reject)=>{
    const socket=tls.connect({host,port,rejectUnauthorized:false},()=>{
      const raw=socket.getPeerCertificate().raw;socket.destroy();
      if(!raw?.length)return reject(new Error(`${host}:${port} presented no certificate`));
      resolve(`-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
    });
    // Healthy means only that the port accepts a connection; the first handshake after it
    // overran 3 seconds on a busy runner (PIPT-49).
    socket.setTimeout(30000,()=>socket.destroy(new Error(`${host}:${port} TLS handshake timed out`)));
    socket.on('error',reject);
  });
}
// GreenMail's SMTPS, IMAPS and POP3S answer with one certificate, which is written for the tests.
async function greenmailCertificate(host,file,read) {
  const pems=await Promise.all([3465,3993,3995].map(port=>read(host,port)));
  if(new Set(pems).size!==1)throw new Error('GreenMail TLS ports presented different certificates');
  fs.writeFileSync(file,pems[0]);
}
export async function probeService(name,host) {
  if(name==='postgres') {
    await connection(host,5432,socket=>{
      const fields=Buffer.from('user\0postgres\0database\0postgres\0\0'),packet=Buffer.alloc(8+fields.length);
      packet.writeInt32BE(packet.length);packet.writeInt32BE(196608,4);fields.copy(packet,8);socket.write(packet);
    },(bytes,socket,finish)=>{
      let offset=0;
      while(offset+5<=bytes.length) {
        const type=String.fromCharCode(bytes[offset]),length=bytes.readInt32BE(offset+1);
        if(length<4)throw new Error('invalid Postgres response');
        if(offset+length+1>bytes.length)return;
        if(type==='E')throw new Error('Postgres rejected readiness connection');
        if(type==='Z')return finish();
        offset+=length+1;
      }
    });
  } else if(name==='manticore') {
    const response=await fetch(`http://${host}:9308/sql?mode=raw`,{method:'POST',body:'query=SHOW TABLES',signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error(`Manticore HTTP ${response.status}`);
    const result=await response.json();
    if(!Array.isArray(result) || result.some(row=>row.error))throw new Error('Manticore readiness query failed');
  } else if(name==='greenmail') {
    for(const [port,greeting]of [[3025,/^220 /],[3143,/^\* OK/]]) await connection(host,port,()=>{},(bytes,socket,finish)=>{
      if(!bytes.includes(10))return;
      if(!greeting.test(bytes.toString()))throw new Error('GreenMail readiness greeting failed');
      finish();
    });
  } else throw new Error(`unknown service: ${name}`);
}
const healthChecks={
  postgres:'pg_isready -q -h 127.0.0.1 -U postgres -d postgres',
  manticore:`response=$(wget -q -O - --timeout=2 --tries=1 --post-data='query=SHOW TABLES' 'http://127.0.0.1:9308/sql?mode=raw') && printf '%s' "$response" | grep -Eq '"error"[[:space:]]*:[[:space:]]*""'`,
  greenmail:String.raw`bash -ec 'exec 3<>/dev/tcp/127.0.0.1/3025; IFS= read -r smtp <&3; [[ "$smtp" == 220\ * ]]; exec 3<&-; exec 3>&-; exec 4<>/dev/tcp/127.0.0.1/3143; IFS= read -r imap <&4; [[ "$imap" == \*\ OK* ]]; exec 4<&-; exec 4>&-; for port in 3110 3465 3993 3995; do exec 5<>/dev/tcp/127.0.0.1/$port; exec 5<&-; exec 5>&-; done'`
};
export async function watchHealth(id,names,{subscribe=dockerEvents,timeout=180000,schedule=setTimeout,cancel=clearTimeout}={}) {
  const pending=new Set(names.map(name=>`${id}-${name}`)),controller=new AbortController();
  let resolve,reject,stream;
  const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});
  ready.catch(()=>{});
  const fail=error=>{reject(error);controller.abort(error);};
  const timer=schedule(()=>fail(new Error(`Service readiness deadline exceeded: ${[...pending].join(', ')}`)),timeout);
  const close=()=>{cancel(timer);stream?.close();controller.abort();};
  try {
    stream=await subscribe({type:['container'],label:[`${ownerLabel}=${id}`],event:['health_status','die']},event=>{
      const name=event.Actor?.Attributes?.name;
      if(!names.some(service=>name===`${id}-${service}`))return;
      if(event.Action==='die')return fail(new Error(`${name} exited during readiness`));
      if(event.Action==='health_status: unhealthy')return fail(new Error(`${name} is unhealthy`));
      if(event.Action==='health_status: healthy') {pending.delete(name);if(!pending.size)resolve();}
    },fail,controller.signal);
    return {ready,close};
  } catch(error){const failure=controller.signal.aborted ? controller.signal.reason : error;close();throw failure;}
}
export async function startServices(services=config().service || {},{read=capture,execute=run,probe=probeService,certificate=peerCertificate,subscribe=dockerEvents,timeout=180000}={}) {
  if(fs.existsSync(stateFile()))throw new Error('service state already exists; run services.mjs stop first');
  if(!Object.keys(services).length)return {};
  const state={id:`ci-services-${randomUUID()}`,addresses:{},volumes:[]};
  fs.writeFileSync(stateFile(),JSON.stringify(state));
  const deadline=Date.now()+timeout;
  const remaining=()=>{const value=deadline-Date.now();if(value<=0)throw new Error('Service readiness deadline exceeded');return {timeout:value};};
  const monitor=await watchHealth(state.id,Object.keys(services),{subscribe,timeout});
  try {
  execute('docker',['network','create','--label',`${ownerLabel}=${state.id}`,state.id],remaining());
  for(const [name,image]of Object.entries(services)) {
    if(!['postgres','manticore','greenmail'].includes(name) || !/@sha256:[0-9a-f]{64}$/.test(image))throw new Error('services require known names and digest-pinned images');
    // GreenMail has two accounts, as Postgres signs in postgres on trust: alice@example.com and
    // bob@example.com, password secret, each signing in with its whole address.
    const mail=['-Dgreenmail.setup.test.all','-Dgreenmail.hostname=0.0.0.0',`-Dgreenmail.users=${greenmailUsers.join(',')}`,'-Dgreenmail.users.login=email'];
    const env=name==='postgres' ? ['-e','POSTGRES_HOST_AUTH_METHOD=trust'] : name==='greenmail' ? ['-e',`GREENMAIL_OPTS=${mail.join(' ')}`] : [];
    execute('docker',['run','-d','--name',`${state.id}-${name}`,'--label',`${ownerLabel}=${state.id}`,'--network',state.id,'--network-alias',name,'--health-cmd',healthChecks[name],'--health-interval','1s','--health-timeout','5s','--health-retries','180',...env,image],remaining());
    const info=JSON.parse(read('docker',['inspect',`${state.id}-${name}`],remaining()))[0];
    const address=info.NetworkSettings.Networks[state.id]?.IPAddress;
    if(!net.isIPv4(address))throw new Error(`service ${name} has no bridge IPv4 address`);
    state.addresses[name]=address;
    state.volumes.push(...(info.Mounts || []).filter(mount=>mount.Type==='volume').map(mount=>mount.Name));
    fs.writeFileSync(stateFile(),JSON.stringify(state));
  }
  await monitor.ready;
  await Promise.all(Object.entries(state.addresses).map(async([name,address])=>{await probe(name,address);console.log(`${name} healthy; TCP assertion passed at ${address}`);}));
  if(state.addresses.greenmail) {
    state.certificate=path.join(process.env.RUNNER_TEMP || os.tmpdir(),`${state.id}-greenmail.pem`);
    fs.writeFileSync(stateFile(),JSON.stringify(state));
    await greenmailCertificate(state.addresses.greenmail,state.certificate,certificate);
  }
  } finally {monitor.close();}
  const env=serviceEnvironment(state);
  if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,Object.entries(env).map(([key,value])=>`${key}=${value}\n`).join(''));
  return env;
}
export function stopServices({read=capture,execute=run}={}) {
  if(!fs.existsSync(stateFile()))return;
  const state=readState(),filter=['--filter',`label=${ownerLabel}=${state.id}`],errors=[];
  for(const id of list(read('docker',['ps','-aq',...filter])))try{execute('docker',['rm','-fv',id]);}catch(error){errors.push(error);}
  for(const volume of state.volumes || []) {
    if(!/^[0-9a-f]{64}$/.test(volume))throw new Error('unexpected anonymous service volume name');
    if(read('docker',['volume','ls','-q','--filter',`name=^${volume}$`]))try{execute('docker',['volume','rm',volume]);}catch(error){errors.push(error);}
  }
  for(const id of list(read('docker',['network','ls','-q',...filter])))try{execute('docker',['network','rm',id]);}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'service cleanup failed; state retained for retry');
  if(read('docker',['ps','-aq',...filter]) || read('docker',['network','ls','-q',...filter]))throw new Error('service resources survived cleanup');
  if(state.certificate) {
    if(path.basename(state.certificate)!==`${state.id}-greenmail.pem`)throw new Error('unexpected service certificate path');
    fs.rmSync(state.certificate,{force:true});
  }
  fs.unlinkSync(stateFile());
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='start')await startServices();
  else if(process.argv[2]==='stop')stopServices();
  else throw new Error('services.mjs start|stop');
}
