import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {run, templates, tracked} from '../lib.mjs';
import {tool} from '../tools.mjs';

const check = /(?:\b(?:gofmt|actionlint|kubeconform|markdownlint|pytest|ctest|PSScriptAnalyzer)\b|\bgo\s+(?:vet|test)\b|\bcargo\s+(?:fmt|clippy|test|nextest)\b|\bnode\s+[^\n]*--test\b|\bpython[\d.]*\s+[^\n]*-m\s+unittest\b|\b(?:npm|pnpm)\s+(?:test|run\s+(?:lint|check|test))\b|\btofu\s+(?:fmt|validate|plan)\b|\bdotnet\s+(?:test|format)\b|\b(?:check|test|lint|validate|parse)[-/.\w]*\.(?:m?js|py|ps1|sh)\b)/i;
const prOnly = expression => /github\.event_name\s*==\s*['"]pull_request['"]/.test(expression || '') && !/\|\|/.test(expression || '');
// A whole-line comment (#, or // in JavaScript) runs nothing: neither the words in it nor
// the scripts it names are a step's commands.
const code = text => text.split('\n').filter(line => !/^\s*(?:#|\/\/)/.test(line)).join('\n');
export function scriptText(source, read = () => null, seen = new Set(), from = '') {
  const text = code(source);
  let result = text;
  for (const match of text.matchAll(/(?:^|[\s'"(])([\w./-]+\.(?:m?js|cjs|py|ps1|sh))\b/gm)) {
    const relative = match[1];
    const file = path.posix.normalize(relative.startsWith('.') ? path.posix.join(path.posix.dirname(from), relative) : relative);
    if (seen.has(file) || file.split('/').includes('..') || file.startsWith('/')) continue;
    seen.add(file);
    const child = read(file);
    if (child !== null) result += `\n${scriptText(child, read, seen, file)}`;
  }
  return result;
}
export function dependencies() {
  const files = new Set();
  const read = file => {
    files.add(file);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  };
  for (const file of tracked().filter(f => /^\.forgejo\/workflows\/[^/]+\.ya?ml$/.test(f))) scriptText(fs.readFileSync(file, 'utf8'), read);
  return [...files];
}
// A wait inside a loop is a poll. A single wait for time itself to pass (a cache's freshness
// running out, which nothing announces) isn't, so a sleep counts only inside a loop: a shell
// sleep between a loop's do and done, a Python sleep under a for or while. PowerShell's and
// JavaScript's waits still count beside any loop word.
function shellLoopSleep(text) {
  let depth = 0;
  for (const [, word] of text.matchAll(/(?<![\w.$-])(do|done|sleep)(?![\w-])/g)) {
    if (word === 'do') depth++;
    else if (word === 'done') depth = Math.max(0, depth - 1);
    else if (depth > 0) return true;
  }
  return false;
}
function pythonLoopSleep(text) {
  const lines = text.split('\n');
  return lines.some((line, index) => {
    if (!/\b(?:time|asyncio)\.sleep\(/.test(line)) return false;
    let indent = line.search(/\S/);
    for (let j = index - 1; j >= 0 && indent > 0; j--) {
      const above = lines[j].search(/\S/);
      if (above < 0 || above >= indent) continue;
      if (/^\s*(?:async\s+)?(?:for|while)\b/.test(lines[j])) return true;
      indent = above;
    }
    return false;
  });
}
export function loopWaits(commands) {
  return shellLoopSleep(commands) || pythonLoopSleep(commands) ||
    (/\b(?:Start-Sleep|setTimeout|setInterval)\b/i.test(commands) && /\b(?:while|until|for|retry|retries)\b/i.test(commands));
}
export function violations(text, read) {
  const document = YAML.parseDocument(text, {uniqueKeys: true});
  if (document.errors.length) return document.errors.map(e => e.message);
  const workflow = document.toJS();
  const bad = [];
  if (!workflow || typeof workflow !== 'object') return ['workflow must be a mapping'];
  const events = workflow.on;
  const triggers = typeof events === 'string' ? {[events]: null} : Array.isArray(events) ? Object.fromEntries(events.map(e => [e, null])) : events || {};
  if ('schedule' in triggers) bad.push('scheduled checks rerun unchanged code');
  for (const [event, settings] of Object.entries(triggers)) {
    if (settings && ('paths' in settings || 'paths-ignore' in settings)) bad.push(`${event}: trigger paths prevent skipped statuses`);
  }
  const cancel = String(workflow.concurrency?.['cancel-in-progress']).replace(/\s/g, '');
  if (!["${{github.event_name=='pull_request'}}", '${{github.event_name=="pull_request"}}'].includes(cancel)) {
    bad.push('workflow concurrency must cancel exactly pull_request runs');
  }
  if (!String(workflow.concurrency?.group).includes('github.ref')) bad.push('concurrency group must include github.ref to isolate PRs');
  for (const [name, job] of Object.entries(workflow.jobs || {})) {
    for (const step of job.steps || []) {
      const commands = scriptText(step.run || '', read);
      if (loopWaits(commands)) bad.push(`${name}: loop waits on a runner`);
      if (/\bgh\s+(?:run\s+watch|pr\s+checks\b.*--watch)|ConnectionAttempts\s*[= ]\s*(?:[2-9]|\d{2,})|(?<![?&])\b(?:poll|wait-for-merge|wait-for-dns)\b/i.test(commands)) bad.push(`${name}: polling holds a runner`);
      if (/\b(?:while|until)\b/.test(commands) && /\b(?:curl|wget|fetch)\s*[(\s]/.test(commands)) bad.push(`${name}: request loop holds a runner`);
      const isCheck = check.test(commands) || /\/(?:check-|lint|test)/.test(step.uses || '') || /^(?:check|test|lint|validate|plan|parse)(?:-|$)/i.test(name);
      if (isCheck && !prOnly(job.if) && !prOnly(step.if)) bad.push(`${name}: check must be guarded by github.event_name == 'pull_request'`);
    }
    if (job.uses && !prOnly(job.if) && /(?:check|test|lint|validate|plan)/i.test(name)) bad.push(`${name}: reusable checks must be PR-only`);
  }
  return [...new Set(bad)];
}
// What actionlint reports that Forgejo runs as written: its own job key, the services
// command it adds, and YAML anchors, which actionlint doesn't follow.
export const actionlintIgnores = ['unexpected key "enable-openid-connect"', 'unexpected key "cmd" for "services" section', 'found alias node'];
export async function main() {
  let bad = 0;
  const files = tracked().filter(f => /^\.forgejo\/workflows\/[^/]+\.ya?ml$/.test(f));
  for (const file of files) {
    const errors = violations(fs.readFileSync(file, 'utf8'), p => fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null);
    for (const error of errors) console.error(`${file}: ${error}`);
    bad += errors.length;
  }
  // Forgejo checks a workflow only when it runs it; actionlint finds a context used where
  // none exists, an unknown key or a bad expression on the pull request. Shell and Python
  // inside steps aren't linted here.
  if (files.length) {
    try {
      run(await tool('actionlint'), ['-config-file', path.join(templates, '.github', 'actionlint.yaml'), '-shellcheck=', '-pyflakes=', ...actionlintIgnores.flatMap(i => ['-ignore', i]), ...files]);
    } catch { bad++; }
  }
  if (bad) throw new Error(`${bad} CI rule violations`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
