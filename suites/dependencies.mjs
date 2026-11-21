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
// An image's inputs: its Dockerfile and .dockerignore in its build context (`context`, the
// repository root by default), what that Dockerfile copies in, and ci/smoke/.
export function imageInputs(section = {}, read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) {
  const context = section.context || '.';
  const at = name => context === '.' ? name : path.posix.join(context, name);
  const text = read(at('Dockerfile'));
  return [at('Dockerfile'), at('.dockerignore'), 'ci/smoke/**', ...(text ? dockerSources(text).map(at) : [])];
}
// What an npm package in a directory of its own reads outside it (rule 2), as its files name it:
// the relative modules its sources import (`import`, `export ... from`, `import()`, `require()`,
// `new URL(..., import.meta.url)`), the paths they join onto their own folder (`__dirname`,
// `import.meta.dirname`, or a name given `dirname(fileURLToPath(import.meta.url))`), the `../`
// paths in the scripts `npm run lint` and `npm test` run (web-app/test.mjs), its `file:` and
// `link:` dependencies, and its tsconfig's `extends`: the paths, each a file or a folder.
const sourceFile = /\.[cm]?[jt]sx?$/;
const quoted = String.raw`(['"\x60])([^'"\x60$\n]+)\1`;
export function packageReferences(dir, files = tracked(), read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) {
  if (dir === '.') return [];
  const result = new Set();
  const add = (from, target) => {
    const name = path.posix.normalize(path.posix.join(from, target)).replace(/\/+$/, '');
    if (name === '.' || name === '..' || name.startsWith('../') || name === dir || name.startsWith(`${dir}/`)) return;
    result.add(name);
  };
  for (const file of files.filter(file => file.startsWith(`${dir}/`) && sourceFile.test(file))) {
    const text = read(file);
    if (!text) continue;
    const from = path.posix.dirname(file);
    for (const match of text.matchAll(new RegExp(String.raw`(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*${quoted}`, 'g'))) if (match[2].startsWith('.')) add(from, match[2]);
    for (const match of text.matchAll(new RegExp(String.raw`\bnew\s+URL\s*\(\s*${quoted}\s*,\s*import\.meta\.url\s*\)`, 'g'))) add(from, match[2]);
    const folders = ['__dirname', String.raw`import\.meta\.dirname`,
      ...[...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?dirname\s*\(\s*(?:url\.)?fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)/g)].map(match => match[1].replace(/\$/g, '\\$'))];
    for (const match of text.matchAll(new RegExp(String.raw`\b(?:path\.)?(?:join|resolve)\s*\(\s*(?:${folders.join('|')})\s*((?:,\s*${quoted.replace('\\1', '\\2')}\s*)+)`, 'g'))) {
      add(from, path.posix.join(...[...match[1].matchAll(new RegExp(quoted, 'g'))].map(literal => literal[2])));
    }
  }
  let manifest = {};
  try { manifest = JSON.parse(read(`${dir}/package.json`) || '{}'); } catch { /* not a package */ }
  const scripts = manifest.scripts || {}, pending = ['lint', 'test'], seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name) || typeof scripts[name] !== 'string') continue;
    seen.add(name);
    pending.push(`pre${name}`, `post${name}`);
    for (const match of scripts[name].matchAll(/\bnpm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|t)\b)/g)) pending.push(match[1] || 'test');
    for (const word of scripts[name].split(/[\s;&|()<>]+/)) {
      const token = word.replace(/^['"]|['"]$/g, '').replace(/^--?[\w-]+=/, '');
      if (token.startsWith('../')) add(dir, token);
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const spec of Object.values(manifest[field] || {})) if (typeof spec === 'string' && /^(?:file|link):/.test(spec)) add(dir, spec.replace(/^(?:file|link):/, ''));
  }
  for (const file of files.filter(file => path.posix.dirname(file) === dir && /^tsconfig[\w.-]*\.json$/.test(path.posix.basename(file)))) {
    for (const match of (read(file) || '').matchAll(/"extends"\s*:\s*(?:"([^"]+)"|\[([^\]]*)\])/g)) {
      for (const target of match[1] ? [match[1]] : [...match[2].matchAll(/"([^"]+)"/g)].map(m => m[1])) if (target.startsWith('.')) add(dir, target);
    }
  }
  return [...result].sort();
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
