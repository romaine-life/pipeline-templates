import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {targetDirectory} from '../rust/cache.mjs';
test('Cargo reuses each job folder and removes the old toolchain only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-cache-'));
  try {
    const dir = targetDirectory(root, '1.100.0', 'test-windows');
    fs.writeFileSync(path.join(dir, 'compiled'), 'kept');
    assert.equal(targetDirectory(root,'1.100.0','test-windows'), dir);
    assert.ok(fs.existsSync(path.join(dir,'compiled')));
    const build = targetDirectory(root,'1.100.0','release-windows');
    assert.notEqual(build, dir);
    const next = targetDirectory(root,'1.101.0','test-windows');
    assert.ok(fs.existsSync(next));
    assert.equal(fs.existsSync(dir), false);
    assert.throws(() => targetDirectory(root, '../outside', 'test'), /invalid/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('Linux cleanup leaves a toolchain whose build holds its shared lock', {skip:process.platform!=='linux'}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cargo-lock-'));
  const dir=targetDirectory(root,'1.100.0','test');
  const child=spawn('flock',['-s',path.join(root,'1.100.0.lock'),process.execPath,'-e','process.stdout.write("locked"); process.stdin.resume()'],{stdio:['pipe','pipe','inherit']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    targetDirectory(root,'1.101.0','test');
    assert.ok(fs.existsSync(dir));
  } finally {
    const exit=new Promise(resolve=>child.once('exit',resolve));
    child.stdin.end(); await exit;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
