import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {run,capture} from '../lib.mjs';
import {tool} from '../tools.mjs';
import {zipSync,unzipSync} from 'fflate';
import {createPrivateKey,sign,verify,X509Certificate,constants} from 'node:crypto';
import {hash} from '../lib.mjs';
import {zipDirectory} from './zip.mjs';
export const archiveSignatureName=name=>`${name}.signature.json`;
export async function signLinux(directory='dist') {
  const temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'sign-'));
  const pfx=Buffer.from(process.env.AT_TERMINAL_PFX || '','base64');
  let executable;
  try {
    function certificate() {
      if (!pfx.length) throw new Error('AT_TERMINAL_PFX is missing');
      if (fs.existsSync(path.join(temp,'cert.pem'))) return;
      fs.writeFileSync(path.join(temp,'cert.pfx'),pfx,{mode:0o600});
      fs.writeFileSync(path.join(temp,'password'),process.env.AT_TERMINAL_PFX_PASSWORD || '',{mode:0o600});
      run('openssl',['pkcs12','-in',path.join(temp,'cert.pfx'),'-passin',`file:${path.join(temp,'password')}`,'-clcerts','-nokeys','-out',path.join(temp,'cert.pem')]);
    }
    async function visit(dir,depth=0) {
      if (depth>8) throw new Error('release archive nesting is too deep');
      let changed=false;
      for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const input=path.join(dir,entry.name);
        if (entry.isDirectory()) {changed=await visit(input,depth) || changed;continue;}
        if (!entry.isFile()) throw new Error('release packages contain only regular files and directories');
        if (entry.name.endsWith('.zip')) {
          const unpack=fs.mkdtempSync(path.join(temp,'zip-'));
          const entries=unzipSync(fs.readFileSync(input));
          for (const [name,data] of Object.entries(entries)) {
            if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('ZIP contains an unsafe path');
            const file=path.join(unpack,name);
            if (name.endsWith('/'))fs.mkdirSync(file,{recursive:true});
            else {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
          }
          if (await visit(unpack,depth+1)) {
            fs.writeFileSync(input,zipDirectory(unpack));
          }
          certificate();
          const keyFile=path.join(temp,'key.pem');
          if (!fs.existsSync(keyFile)) {
            fs.writeFileSync(keyFile,'',{mode:0o600});
            run('openssl',['pkcs12','-in',path.join(temp,'cert.pfx'),'-passin',`file:${path.join(temp,'password')}`,'-nocerts','-nodes','-out',keyFile]);
          }
          const keyBytes=fs.readFileSync(keyFile);
          try {
            const cert=new X509Certificate(fs.readFileSync(path.join(temp,'cert.pem'))),digest=hash(fs.readFileSync(input));
            const message=Buffer.from(`${process.env.GITHUB_REPOSITORY}\n${process.env.VERSION}\n${digest}\n`);
            const signature=sign('sha256',message,{key:createPrivateKey(keyBytes),padding:constants.RSA_PKCS1_PADDING});
            if (!verify('sha256',message,cert.publicKey,signature)) throw new Error('archive signature did not verify');
            fs.writeFileSync(archiveSignatureName(input),JSON.stringify({repo:process.env.GITHUB_REPOSITORY,tag:process.env.VERSION,sha256:digest,certificate:cert.raw.toString('base64'),signature:signature.toString('base64')}));
          }finally{keyBytes.fill(0);}
          changed=true;
        } else if (entry.name.endsWith('.tar.gz')) {
          const names=capture('tar',['-tzf',input]).split('\n');
          const types=capture('tar',['-tvzf',input]).split('\n');
          if (names.some(n=>n.startsWith('/') || n.includes('\\') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) || types.some(t=>t && !['-','d'].includes(t[0]))) throw new Error('release archive contains unsafe paths or links');
          const unpack=fs.mkdtempSync(path.join(temp,'package-'));
          run('tar',['-xzf',input,'-C',unpack]);
          if (await visit(unpack,depth+1)) {
            const packed=path.join(temp,`${path.basename(unpack)}.tar.gz`);
            run('tar',['-czf',packed,'-C',unpack,'.']);fs.copyFileSync(packed,input);changed=true;
          }
        } else if (/\.(exe|dll|msi|cab)$/i.test(entry.name)) {
          if (!pfx.length) throw new Error('AT_TERMINAL_PFX is missing');
          if (!executable) {
            certificate();
            executable=await tool('osslsigncode');
          }
          const output=path.join(temp,'signed-output');
          if (fs.existsSync(output)) fs.unlinkSync(output);
          run(executable,['sign','-pkcs12',path.join(temp,'cert.pfx'),'-readpass',path.join(temp,'password'),'-h','sha256','-in',input,'-out',output]);
          run(executable,['verify','-CAfile',path.join(temp,'cert.pem'),'-in',output]);
          fs.copyFileSync(output,input);changed=true;
        }
      }
      return changed;
    }
    await visit(path.resolve(directory));
  } finally { pfx.fill(0);fs.rmSync(temp,{recursive:true,force:true}); }
}
if (process.argv[1]?.endsWith('sign-linux.mjs')) await signLinux();
