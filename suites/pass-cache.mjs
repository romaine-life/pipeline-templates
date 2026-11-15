import {hash} from './lib.mjs';

const version=hash('home-ci-pass-json-v1');
export function passCache({base=process.env.ACTIONS_CACHE_URL,token=process.env.ACTIONS_RUNTIME_TOKEN,send=fetch}={}) {
  if(!base || !token)throw new Error('check records require the runner Actions cache');
  const root=new URL(base.endsWith('/')?base:base+'/');
  async function call(resource,{method='GET',body,headers={}}={}) {
    const response=await send(new URL('_apis/artifactcache/'+resource,root),{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json;api-version=6.0-preview.1',...headers},body,signal:AbortSignal.timeout(30000)});
    if(response.status===204 || response.status===409)return null;
    if(!response.ok)throw new Error(`Actions cache ${method}: HTTP ${response.status}`);
    return response;
  }
  return {
    async get(key) {
      const response=await call(`cache?keys=${encodeURIComponent(key+'-')}&version=${version}`);
      if(!response)return null;
      const entry=await response.json();
      if(!entry.cacheKey?.startsWith(key+'-'))return null;
      const address=new URL(entry.archiveLocation,root);
      const download=await send(address,{headers:address.origin===root.origin?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(30000)});
      if(!download.ok)throw new Error(`Actions cache download: HTTP ${download.status}`);
      let size=0,text='';
      const decoder=new TextDecoder();
      for await(const chunk of download.body){size+=chunk.length;if(size>16384)throw new Error('oversized check record');text+=decoder.decode(chunk,{stream:true});}
      return JSON.parse(text+decoder.decode());
    },
    async set(key,value) {
      const body=Buffer.from(JSON.stringify(value));
      if(body.length>16384)throw new Error('oversized check record');
      const reservation=await call('caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:`${key}-${value.run}`,version,cacheSize:body.length})});
      if(!reservation)return;
      const {cacheId}=await reservation.json();
      if(!Number.isSafeInteger(cacheId))throw new Error('invalid Actions cache reservation');
      await call(`caches/${cacheId}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes 0-${body.length-1}/*`},body});
      await call(`caches/${cacheId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({size:body.length})});
    }
  };
}
