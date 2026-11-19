import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stage, sourceRelease, publish, releaseScope} from '../release.mjs';
import {run, capture} from '../lib.mjs';
import {fleetEntry, currentEntry} from './fleet-entry.mjs';

test('drafts recover interrupted uploads and published assets are immutable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'release-'));
  const asset = path.join(dir,'probe.exe');
  fs.writeFileSync(asset,'signed-binary');
  let release = null, calls = [], deny = false;
  const server = http.createServer(async (req,res) => {
    calls.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization,'token test-only');
    res.setHeader('Content-Type','application/json');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (deny) { res.writeHead(403).end('{}'); return; }
    if (req.method==='GET') { res.writeHead(release ? 200 : 404).end(JSON.stringify(release || {})); return; }
    if (req.url==='/releases' && req.method==='POST') release={...JSON.parse(body),id:1,assets:[]};
    if (req.method==='PATCH') release={...release,...JSON.parse(body)};
    if (req.method==='DELETE') release.assets=[];
    if (req.url.startsWith('/releases/1/assets?')) {
      assert.match(body,/signed-binary/);
      release.assets.push({id:2,name:'probe.exe',size:13});
    }
    res.writeHead(req.method==='DELETE' ? 204 : 200).end(JSON.stringify(release));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const args={url:`http://127.0.0.1:${server.address().port}`,tag:'v0.1.1',sha:'a'.repeat(40),files:[asset],token:'test-only'};
  try {
    await stage(args);
    assert.equal(release.draft,true);
    assert.equal(release.assets.length,1);
    calls=[];
    await stage(args);
    assert.ok(calls.includes('DELETE /releases/1/assets/2'));
    release.draft=false;
    calls=[];
    await stage(args);
    assert.deepEqual(calls,['GET /releases/tags/v0.1.1']);
    fs.writeFileSync(asset,'different');
    await assert.rejects(stage(args),/immutable/);
    release.draft=true;deny=true;
    await assert.rejects(stage(args),/HTTP 403/);
    await assert.rejects(stage({...args,files:[]}),/no assets/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('source release, publication, pruning, dispatch and successful-input gating compose', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-lifecycle-'));
  const cwd=process.cwd(), originalFetch=globalThis.fetch, oldEnv={...process.env};
  let release=null;const calls=[];
  try {
    process.chdir(dir);
    const fleetFile=fleetEntry(({version:1,docs:{release:true}}),'test/source');
    // The repository's own released.yml runs once the release is out.
    fs.mkdirSync('.forgejo/workflows',{recursive:true});fs.writeFileSync('.forgejo/workflows/released.yml','on: workflow_dispatch\n');
    // A fleet repository whose go.mod requires this one's module gets its take-up too.
    const listed=JSON.parse(fs.readFileSync(fleetFile,'utf8'));listed.repos['romaine-life/consumer']={suites:['go']};
    fs.writeFileSync(fleetFile,JSON.stringify(listed));
    fs.writeFileSync('README.md','# Source\n');
    fs.writeFileSync('go.mod','module github.com/romaine-life/source\n');
    run('git',['init','-b','main']);run('git',['add','.']);
    run('git',['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','source']);
    const sha=capture('git',['rev-parse','HEAD']);run('git',['tag','v0.1.1']);
    Object.assign(process.env,{GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main',GITHUB_SERVER_URL:'https://forgejo.romaine.life',GITHUB_REPOSITORY:'test/source',GITHUB_SHA:sha,
      VERSION:'v0.1.1',TOKEN:'repo-token',DISPATCH_TOKEN:'dispatch-token',GITHUB_OUTPUT:path.join(dir,'outputs')});
    globalThis.fetch=async (url,options={}) => {
      const u=String(url),method=options.method || 'GET';calls.push([method,u]);
      assert.equal(options.headers.Authorization,u.includes('/romaine-life/consumer') || u.includes('/push_mirrors') || u.endsWith('/test/source') || u.includes('/test/source/actions/') ? 'token dispatch-token' : 'token repo-token');
      let body={};
      if (u.endsWith('/releases/tags/v0.1.1') && !release) return new Response('{}',{status:404});
      if (u.endsWith('/releases') && method==='POST') release={...JSON.parse(options.body),id:1,assets:[]};
      if (u.includes('/assets?')) release.assets=[{id:2,name:'source.zip',size:1}];
      if (u.endsWith('/releases/1') && method==='PATCH') release={...release,...JSON.parse(options.body)};
      if (u.includes('/releases?')) body=[release];
      else if (u.includes('/releases')) body=release;
      else if (u.endsWith('/push_mirrors')) body=[];
      else if (u.endsWith('/romaine-life/consumer') || u.endsWith('/test/source')) body={default_branch:'master'};
      else if (u.endsWith('/romaine-life/consumer/raw/go.mod?ref=master')) return new Response('module x\n\nrequire github.com/romaine-life/source v0.1.0\n');
      else if (u.endsWith('/dispatches')) {
        assert.deepEqual(JSON.parse(options.body),{ref:'master'});
        return new Response(null,{status:204});
      }
      return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json','x-total-count':'1'}});
    };
    await sourceRelease();assert.equal(release.draft,true);
    assert.ok(fs.statSync('dist/source.zip').size>0);
    await publish();assert.equal(release.draft,false);
    assert.ok(calls.some(([method,url])=>method==='GET' && url.endsWith('/test/source/push_mirrors')) && !calls.some(([,url])=>url.endsWith('/push_mirrors-sync')),'a repository without push mirrors syncs none');
    assert.equal(calls.filter(([method,url])=>method==='POST' && url.endsWith('/romaine-life/consumer/actions/workflows/go%2Fdependencies.yml/dispatches')).length,1);
    assert.equal(calls.filter(([method,url])=>method==='POST' && url.endsWith('/test/source/actions/workflows/released.yml/dispatches')).length,1);
    await releaseScope('docs');assert.match(fs.readFileSync('outputs','utf8'),/build=false/);
    // Started by hand, the same unchanged head releases (PIPT-37).
    process.env.GITHUB_EVENT_NAME='workflow_dispatch';fs.writeFileSync('outputs','');
    await releaseScope('docs');assert.equal(fs.readFileSync('outputs','utf8'),'build=true\n');
    process.env.GITHUB_EVENT_NAME='push';fs.writeFileSync('outputs','');
    await releaseScope('docs');assert.equal(fs.readFileSync('outputs','utf8'),'build=false\n');
    fs.writeFileSync('README.md','# Changed source\n');run('git',['add','README.md']);
    run('git',['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','change']);
    await releaseScope('docs');assert.match(fs.readFileSync('outputs','utf8'),/build=true/);
  } finally {
    globalThis.fetch=originalFetch;process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env,oldEnv);fs.rmSync(dir,{recursive:true,force:true});
  }
});
