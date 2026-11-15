import fs from 'node:fs';
import path from 'node:path';
import {tracked} from './lib.mjs';
import {marked} from 'marked';

export function embedded(files = tracked()) {
  const result = {go: [], rust: []};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    if (file.endsWith('.go')) {
      for (const line of fs.readFileSync(file, 'utf8').matchAll(/^\s*\/\/go:embed\s+(.+)$/gm)) {
        const tokens = line[1].match(/"(?:[^"\\]|\\.)*"|`[^`]*`|\S+/g) || [];
        for (let token of tokens) {
          if (token.startsWith('"')) token = JSON.parse(token);
          if (token.startsWith('`')) token = token.slice(1, -1);
          const name = path.posix.join(path.posix.dirname(file), token.replace(/^all:/, ''));
          result.go.push(name, `${name}/**`);
        }
      }
    }
    if (file.endsWith('.rs')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/\binclude(?:_str|_bytes)?!\s*\(\s*"([^"\n]+)"/g)) result.rust.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  return result;
}
export function dockerSources(text) {
  const result = [];
  for (const match of text.replace(/\\\r?\n/g, ' ').matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gmi)) {
    let rest = match[1].trim();
    if (/^--from(?:=|\s)/.test(rest)) continue;
    rest = rest.replace(/^(?:--[\w-]+=\S+\s+)*/, '');
    const args = rest.startsWith('[') ? JSON.parse(rest) : rest.split(/\s+/);
    for (const source of args.slice(0, -1)) {
      const name = source.replace(/^\.\//, '').replace(/\/$/, '');
      if (!name || name === '.' || name.includes('$') || name.includes('://') || name.split('/').includes('..')) throw new Error(`Dockerfile must COPY named local inputs, not ${source}`);
      result.push(name, `${name}/**`);
    }
  }
  return result;
}
export function localLinks(file, text) {
  const result = [];
  marked.walkTokens(marked.lexer(text), token => {
    if (!['link', 'image'].includes(token.type)) return;
    const target = token.href.split(/[?#]/)[0];
    if (!target || /^[\w+.-]+:/.test(target) || target.startsWith('//')) return;
    result.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target))));
  });
  return result;
}
export function docLinks(files = tracked()) {
  const result = [];
  for (const file of files.filter(f => f.endsWith('.md'))) {
    result.push(...localLinks(file, fs.readFileSync(file, 'utf8')));
  }
  return result;
}
