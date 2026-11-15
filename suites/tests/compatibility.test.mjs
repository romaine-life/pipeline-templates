import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {capture,templates} from '../lib.mjs';

const audit=JSON.parse(fs.readFileSync(new URL('./compatibility-audit.json',import.meta.url),'utf8'));
test('unmigrated callers retain byte-identical legacy workflows and their exported contracts',()=>{
  for(const file of audit.restored)assert.equal(capture('git',['-C',templates,'hash-object',file.path]),file.blob,`${file.path}: legacy workflow bytes changed`);
  for(const item of audit.interfaces) {
    const definition=YAML.parse(fs.readFileSync(path.join(templates,item.path),'utf8'));
    const current=item.path.startsWith('actions/')?definition:definition.on.workflow_call;
    for(const [name,input] of Object.entries(item.inputs)) {
      const actual=current.inputs?.[name];assert.ok(actual,`${item.path}: removed input ${name}`);
      assert.deepEqual({required:actual.required===true,...(actual.type===undefined?{}:{type:actual.type}),...(Object.hasOwn(actual,'default')?{default:actual.default}:{})},input,`${item.path}: changed input ${name}`);
    }
    for(const [name,output] of Object.entries(item.outputs)) {
      assert.ok(Object.hasOwn(current.outputs || {},name),`${item.path}: removed output ${name}`);
      const value=current.outputs[name].value;
      assert.deepEqual(value===undefined?{}:{value},output,`${item.path}: changed output ${name}`);
    }
    for(const [name,input] of Object.entries(current.inputs || {}))if(!Object.hasOwn(item.inputs,name))assert.notEqual(input.required,true,`${item.path}: new required input ${name}`);
    for(const caller of item.callers.filter(caller=>caller.ref==='main')) {
      assert.ok(audit.repositories.some(repo=>repo.repository===caller.repository && repo.files.includes(caller.file)));
      for(const name of caller.inputs)assert.ok(Object.hasOwn(current.inputs || {},name),`${caller.repository}: ${item.path} input ${name}`);
      for(const name of caller.outputs)assert.ok(Object.hasOwn(current.outputs || {},name),`${caller.repository}: ${item.path} output ${name}`);
    }
  }
  assert.deepEqual(audit.issues,[]);
});
