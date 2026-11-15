import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'acorn';
import {templates} from '../lib.mjs';

test('local modules have no import cycles involving top-level await',()=>{
  const modules=new Map();
  function files(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.name==='node_modules')continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())files(file);
      else if(/\.(mjs|js)$/.test(file))modules.set(file,{edges:[],await:false});
    }
  }
  files(path.join(templates,'suites'));files(path.join(templates,'actions'));
  const dynamicRequires=[];
  for(const [file,info]of modules) {
    const source=fs.readFileSync(file,'utf8');
    function walk(node,depth=0) {
      if(depth===0 && (node.type==='AwaitExpression' || node.type==='ForOfStatement' && node.await))info.await=true;
      let specifier;
      if(['ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration','ImportExpression'].includes(node.type) && node.source) {
        assert.equal(node.source.type,'Literal',`${file}: audit nonliteral dynamic import`);specifier=node.source.value;
      }
      if(node.type==='CallExpression' && node.callee.type==='Identifier' && node.callee.name==='require') {
        const argument=node.arguments[0];
        if(argument?.type==='Literal')specifier=argument.value;
        else if(argument?.type==='CallExpression' && argument.callee.type==='MemberExpression' && argument.callee.object.name==='path' && argument.callee.property.name==='join' && argument.arguments[0]?.name==='templates' && argument.arguments.slice(1).every(part=>part.type==='Literal'))specifier=path.join(templates,...argument.arguments.slice(1).map(part=>part.value));
        else dynamicRequires.push(`${path.relative(templates,file)}: ${source.slice(node.start,node.end)}`);
      }
      if(typeof specifier==='string' && (specifier.startsWith('.') || path.isAbsolute(specifier))) {
        const target=path.resolve(path.dirname(file),specifier);
        assert.ok(modules.has(target),`${file}: missing local module ${specifier}`);info.edges.push(target);
      }
      const next=depth+(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)?1:0);
      for(const value of Object.values(node)) {
        if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,next);}
        else if(value?.type)walk(value,next);
      }
    }
    walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));
  }
  const scope=modules.get(path.join(templates,'suites/inputs.mjs'));
  assert.equal(scope.await,true);
  assert.ok(scope.edges.includes(path.join(templates,'suites/release/inputs.mjs')));
  const indexes=new Map(),low=new Map(),active=new Set(),stack=[],cycles=[];let index=0;
  function visit(file) {
    indexes.set(file,index);low.set(file,index++);stack.push(file);active.add(file);
    for(const edge of modules.get(file).edges) {
      if(!indexes.has(edge)){visit(edge);low.set(file,Math.min(low.get(file),low.get(edge)));}
      else if(active.has(edge))low.set(file,Math.min(low.get(file),indexes.get(edge)));
    }
    if(low.get(file)===indexes.get(file)) {
      const component=[];let next;
      do{next=stack.pop();active.delete(next);component.push(next);}while(next!==file);
      if(component.length>1 || modules.get(file).edges.includes(file))cycles.push(component);
    }
  }
  for(const file of modules.keys())if(!indexes.has(file))visit(file);
  const describe=cycle=>cycle.map(file=>path.relative(templates,file));
  console.log(JSON.stringify({modules:modules.size,cycles:cycles.map(describe),dynamicRequires}));
  assert.deepEqual(dynamicRequires,[],'audit unresolved local require expressions');
  assert.deepEqual(cycles.filter(cycle=>cycle.some(file=>modules.get(file).await)).map(describe),[]);
});
