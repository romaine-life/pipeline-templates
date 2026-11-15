import test from 'node:test';
import assert from 'node:assert/strict';
import {passCache} from '../pass-cache.mjs';
test('Actions cache stores bounded JSON through the native reserve/upload/commit protocol',async()=>{
  let stored=null,committed=false;
  const cache=passCache({base:'https://cache.example/',token:'runtime-secret',send:async(address,options)=>{
    assert.equal(options.headers.Authorization,'Bearer runtime-secret');
    const url=new URL(address);
    if(url.pathname.endsWith('/cache'))return committed?Response.json({cacheKey:'key-7',archiveLocation:'https://cache.example/data'}):new Response(null,{status:204});
    if(url.pathname==='/data')return Response.json(JSON.parse(stored));
    if(url.pathname.endsWith('/caches')){assert.equal(JSON.parse(options.body).key,'key-7');return Response.json({cacheId:1});}
    if(options.method==='PATCH'){stored=options.body.toString();assert.equal(options.headers['Content-Range'],`bytes 0-${Buffer.byteLength(stored)-1}/*`);return new Response(null,{status:204});}
    if(options.method==='POST'){committed=true;assert.equal(JSON.parse(options.body).size,Buffer.byteLength(stored));return new Response(null,{status:204});}
    throw new Error(url);
  }});
  assert.equal(await cache.get('key'),null);await cache.set('key',{run:7});assert.deepEqual(await cache.get('key'),{run:7});
  await assert.rejects(cache.set('key',{data:'a'.repeat(16385)}),/oversized/);
});
test('cache prefixes cannot match a different fingerprint and download credentials stay on the cache origin',async()=>{
  let key='other',authorized;
  const cache=passCache({base:'https://cache.example/',token:'runtime-secret',send:async(address,options)=>{
    if(new URL(address).hostname==='cache.example')return Response.json({cacheKey:key,archiveLocation:'https://storage.example/data'});
    authorized=options.headers.Authorization;return Response.json({run:1});
  }});
  assert.equal(await cache.get('key'),null);key='key-1';assert.deepEqual(await cache.get('key'),{run:1});assert.equal(authorized,undefined);
});
