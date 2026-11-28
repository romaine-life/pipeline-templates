import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {run, templates, tracked} from '../lib.mjs';
import {lintArgs, tool} from '../tools.mjs';
import {currentTopics} from '../topics.mjs';

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
    // _ci is the suites' checkout, whose scripts pipeline-templates holds to these rules: a
    // repository's workflow that runs one isn't judged by the suite's code (this file's own
    // words for a poll and a loop among it). In pipeline-templates itself, where the suite is
    // at suites/, this file is still skipped: its words for a poll are patterns, not commands.
    if (seen.has(file) || file.split('/').includes('..') || file.startsWith('/') || file === '_ci' || file.startsWith('_ci/') || file === 'suites/default/rules.mjs') continue;
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
// sleep between a loop's do and done, a Python sleep under a for or while, and a JavaScript
// or PowerShell wait inside a loop's braces.
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
// A request in a shell while/until loop is a poll: a curl or wget in its condition or between
// its do and done. A for loop walks a list, a request per item, and isn't one; a JavaScript
// loop that polls waits through setTimeout, which counts above; and a while that parses a file
// beside an unrelated fetch is neither.
export function shellLoopRequest(text) {
  const loops = [];
  let pending = null, waiting = 0;
  for (const [, word] of text.matchAll(/(?<![\w.$-])(while|until|for|do|done|curl|wget)(?![\w-])/g)) {
    if (word === 'while' || word === 'until' || word === 'for') pending = word === 'for' ? 'for' : 'wait';
    else if (word === 'do') { loops.push(pending || 'for'); if (pending === 'wait') waiting++; pending = null; }
    else if (word === 'done') { if (loops.pop() === 'wait') waiting--; }
    else if (pending === 'wait' || waiting > 0) return true;
  }
  return false;
}
// A JavaScript or PowerShell wait counts inside a loop's braces: a Start-Sleep, a setTimeout
// or setInterval, or a helper named for one (a sleep or delay built on setTimeout). A method's
// setTimeout is a socket's or a request's I/O deadline, and a timer outside a loop a deadline.
// String literals are dropped first: their words and braces (a shell command a script holds,
// an error message) aren't the script's loops.
function bracedLoopWait(source) {
  const text = source.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  const helpers = [...text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>[^\n;]*(?<![\w.$])setTimeout\b|\bfunction\s+([\w$]+)\s*\([^)]*\)\s*\{[^\n]*(?<![\w.$])setTimeout\b|\bsetTimeout\s+as\s+([\w$]+)|\{[^}]*\bsetTimeout\s*:\s*([\w$]+)/g)]
    .map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
  const waits = ['setTimeout', 'setInterval', ...helpers].map(w => w.replace(/\$/g, '\\$')).join('|');
  // A loop's header waits for its body's brace; a braceless body ends at the statement's
  // semicolon, outside the header's parentheses.
  const blocks = [];
  let header = false, parens = 0;
  for (const [token] of text.matchAll(new RegExp(`[{}();]|(?<![\\w.$-])(?:foreach|for|while|until|do|[Ff]or[Ee]ach-[Oo]bject|[Ss]tart-[Ss]leep|${waits})(?![\\w$-])`, 'g'))) {
    if (token === '{' && header && parens) blocks.push(false);
    else if (token === '{') { blocks.push(header); header = false; }
    else if (token === '}') blocks.pop();
    else if (token === '(') parens++;
    else if (token === ')') parens = Math.max(0, parens - 1);
    else if (token === ';') { if (!parens) header = false; }
    else if (/^(?:foreach|for|while|until|do|foreach-object)$/i.test(token)) { header = true; parens = 0; }
    else if (header || blocks.includes(true)) return true;
  }
  return false;
}
// A step whose waiting is its job says why on a line of its own, `# waits: <why>` or
// `// waits: <why>`: the release's delivery to the home PCs, which waits for each PC's
// result and for a woken PC to answer (AHT-183), is the one.
export const waitsOnPurpose = commands => /^[ \t]*(?:#|\/\/)[ \t]*waits:[ \t]*\S/m.test(commands);
export function loopWaits(commands) {
  return shellLoopSleep(commands) || pythonLoopSleep(commands) || bracedLoopWait(commands);
}
// A command that builds the repository's own Go: `go build`, or `go install` of a local
// package (one installing a published tool at a version, `pkg@v1`, builds none of it).
export const goBuild = commands => commands.split('\n').some(line => /\bgo\s+build\b/.test(line) || /\bgo\s+install\b/.test(line) && !/@/.test(line));
// A Go repository (a root go.mod) builds, tests and releases its Go through the go and release
// suites. A Forgejo copy of a repository developed on GitHub, which its forgejo-sync workflow
// fast-forwards, is built where it is developed.
export function goViolations(topics, files, read) {
  if (!files.includes('go.mod')) return [];
  const bad = [];
  if (!topics.includes('ci-go') && !files.includes('.github/workflows/forgejo-sync.yml')) bad.push('go.mod: a Go repository takes the go suite (fleet.json)');
  if (topics.includes('ci-release') && !topics.includes('release-go') && !topics.includes('release-module')) {
    const programs = [...new Set(files.filter(f => /^cmd\/[^/]+\/[^/]+\.go$/.test(f) && !f.endsWith('_test.go')).map(f => f.split('/').slice(0, 2).join('/')))];
    if (files.some(f => /^[^/]+\.go$/.test(f) && !f.endsWith('_test.go') && /^package main\b/m.test(read(f) || ''))) programs.unshift('.');
    for (const program of programs) bad.push(`${program}: a Go program the release doesn't build (release-go, and a build for it in .goreleaser.yaml)`);
  }
  return bad;
}
// A step that cuts a release, which only the release suite does: one that reserves a version
// (release-version publishing; with publish 'false' it only names the version a build would
// take), a release action, a release tool's create, edit, upload or delete, or a write to
// Forgejo's or GitHub's release API. A part the suite can't build is the repository's
// build.yml under release-external, which the suite dispatches and completes with its own
// scripts.
const releaseActions = /(?:^|\/)(?:release-version|action-gh-release|create-release|release-action|upload-release-asset|gitea-release-action|forgejo-release)(?:@|$)/;
const releaseTool = /\b(?:gh\s+release\s+(?:create|edit|upload|delete)|tea\s+releases?\s+(?:create|edit|delete)|goreleaser\s+release)\b/;
const releaseWrite = /(?:-Method\s+['"]?(?:Post|Put|Patch|Delete)|-X\s*['"]?(?:POST|PUT|PATCH|DELETE)|--request\s+['"]?(?:POST|PUT|PATCH|DELETE)|\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|\b(?:curl|wget)\b[^\n]*\s(?:-d|--data[-\w]*|-F|--form|-T|--upload-file)\s)/i;
export function cutsRelease(step, commands) {
  const action = (step.uses || '').split('@')[0];
  if (releaseActions.test(action) && !(action.endsWith('release-version') && String(step.with?.publish) === 'false')) return true;
  // A command continued over lines (shell's \, PowerShell's `) is one command.
  const joined = commands.replace(/[\\`]\r?\n/g, ' ');
  // A write names the release API itself, or a variable the step set to it ($api = ".../releases").
  const lines = joined.split('\n');
  const names = lines.flatMap(line => [...line.matchAll(/(?:^|[\s;])\$?(?:env:)?([A-Za-z_]\w*)\s*=\s*[^\n]*\/releases\b/g)].map(m => m[1]));
  const release = new RegExp(`/releases\\b${names.length ? `|\\$\\{?(?:env:)?(?:${names.join('|')})\\b` : ''}`);
  return releaseTool.test(joined) || lines.some(line => release.test(line) && releaseWrite.test(line));
}
export function violations(text, read, {go = false} = {}) {
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
      if (loopWaits(commands) && !waitsOnPurpose(step.run || "")) bad.push(`${name}: loop waits on a runner`);
      if (/\bgh\s+(?:run\s+watch|pr\s+checks\b.*--watch)|ConnectionAttempts\s*[= ]\s*(?:[2-9]|\d{2,})|(?<![?&])\b(?:poll|wait-for-merge|wait-for-dns)\b/i.test(commands)) bad.push(`${name}: polling holds a runner`);
      if (shellLoopRequest(commands)) bad.push(`${name}: request loop holds a runner`);
      if (go && goBuild(commands)) bad.push(`${name}: builds the repository's Go, which the go and release suites build`);
      if (cutsRelease(step, commands)) bad.push(`${name}: cuts a release, which only the release suite does (a part it can't build is build.yml under release-external)`);
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
  const all = tracked(), go = all.includes('go.mod');
  const read = p => fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  const files = all.filter(f => /^\.forgejo\/workflows\/[^/]+\.ya?ml$/.test(f));
  for (const file of files) {
    const errors = violations(fs.readFileSync(file, 'utf8'), read, {go});
    for (const error of errors) console.error(`${file}: ${error}`);
    bad += errors.length;
  }
  const goErrors = goViolations(go ? currentTopics() : [], all, read);
  for (const error of goErrors) console.error(error);
  bad += goErrors.length;
  // Forgejo checks a workflow only when it runs it; actionlint finds a context used where
  // none exists, an unknown key or a bad expression on the pull request, and shellcheck reads
  // every bash and sh step (PIPT-62).
  if (files.length) {
    try {
      run(await tool('actionlint'), ['-config-file', path.join(templates, '.github', 'actionlint.yaml'), ...await lintArgs(actionlintIgnores, files)]);
    } catch { bad++; }
  }
  if (bad) throw new Error(`${bad} CI rule violations`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
