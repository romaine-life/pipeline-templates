// ci-check's half for a repository's own workflow files (.forgejo/workflows, else
// .github/workflows), beside its suites: the jobs a pull request would start there. Each one
// either runs here through its own steps, in the shell it names, or is named with why the
// pull request is left to run it; none is left out of the report (AHT-168).
//
// What a PC can't stand in for leaves a job to the pull request: secrets and variables, a
// matrix, containers (its own or ones it starts), a system package install, a reusable workflow, an action that isn't a composite action this
// copy holds, and setting up the runner's machine. A toolchain setup step (setup-go,
// home-cache and the like) used from pipeline-templates or actions/ is skipped and the PC's
// own tools stand in, as they do for the suites' checks; in pipeline-templates, where those
// actions are what the job tests, the job is left to the pull request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {cacheRoot, capture, run, templates} from './lib.mjs';
import {matches} from './input-patterns.mjs';

const prEvents = ['pull_request', 'pull_request_target'];
const startingTypes = ['opened', 'synchronize', 'reopened'];
const provisioning = new Set(['home-cache', 'setup-go', 'setup-node', 'setup-python', 'setup-uv', 'setup-dotnet', 'setup-opentofu', 'rust-toolchain', 'azure-cli', 'suite']);

// The folder whose workflows the forge runs: Forgejo reads .github only without .forgejo.
export function workflowFolder(root) {
  for (const dir of ['.forgejo/workflows', '.github/workflows']) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// GitHub's path and branch filters: a later `!pattern` takes back what an earlier one matched.
function included(value, patterns) {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (matches(value, p.slice(1))) hit = false; }
    else if (matches(value, p)) hit = true;
  }
  return hit;
}
const list = value => value === undefined || value === null ? undefined : [].concat(value).map(String);

// Whether a pull request into `branch` changing `files` starts a workflow with this `on:`.
export function starts(on, files, branch) {
  const events = typeof on === 'string' ? {[on]: null} : Array.isArray(on) ? Object.fromEntries(on.map(e => [e, null])) : on || {};
  return prEvents.filter(e => e in events).some(e => {
    const f = events[e] || {};
    const types = list(f.types), branches = list(f.branches), notBranches = list(f['branches-ignore']);
    const paths = list(f.paths), notPaths = list(f['paths-ignore']);
    if (types && !types.some(t => startingTypes.includes(t))) return false;
    if (branches && !included(branch, branches)) return false;
    if (notBranches && included(branch, notBranches)) return false;
    if (paths && !files.some(file => included(file, paths))) return false;
    if (notPaths && files.length && files.every(file => included(file, notPaths))) return false;
    return true;
  });
}

// --- Expressions: the part of the runner's language that workflows here use. ---

function tokens(source) {
  const out = [];
  const re = /\s*(?:('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)\b|(==|!=|<=|>=|&&|\|\||[!<>(),])|([A-Za-z_][\w-]*(?:\.[\w*-]+)*))/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) throw new Error(`can't read ${source}`);
    at = re.lastIndex;
    if (m[1] !== undefined) out.push({lit: m[1].slice(1, -1).replaceAll("''", "'")});
    else if (m[2] !== undefined) out.push({lit: Number(m[2])});
    else if (m[3] !== undefined) out.push({op: m[3]});
    else out.push({word: m[4]});
  }
  return out;
}

export function parse(source) {
  const t = tokens(source);
  let i = 0;
  const peek = op => t[i]?.op === op;
  const take = op => { if (!peek(op)) throw new Error(`can't read ${source}`); i++; };
  const or = () => { let a = and(); while (peek('||')) { i++; a = {op: '||', a, b: and()}; } return a; };
  const and = () => { let a = cmp(); while (peek('&&')) { i++; a = {op: '&&', a, b: cmp()}; } return a; };
  const cmp = () => {
    let a = unary();
    while (['==', '!=', '<', '>', '<=', '>='].some(peek)) { const op = t[i++].op; a = {op, a, b: unary()}; }
    return a;
  };
  const unary = () => { if (peek('!')) { i++; return {op: '!', a: unary()}; } return primary(); };
  const primary = () => {
    const token = t[i++];
    if (!token) throw new Error(`can't read ${source}`);
    if (token.op === '(') { const a = or(); take(')'); return a; }
    if ('lit' in token) return {lit: token.lit};
    if (!token.word) throw new Error(`can't read ${source}`);
    if (['true', 'false', 'null'].includes(token.word)) return {lit: JSON.parse(token.word)};
    if (peek('(')) {
      i++;
      const args = [];
      if (!peek(')')) { args.push(or()); while (peek(',')) { i++; args.push(or()); } }
      take(')');
      return {call: token.word, args};
    }
    return {ref: token.word};
  };
  const ast = or();
  if (i !== t.length) throw new Error(`can't read ${source}`);
  return ast;
}

const statusCalls = new Set(['always', 'success', 'failure', 'cancelled']);
const calls = new Set([...statusCalls, 'contains', 'startsWith', 'endsWith', 'format']);
function walk(ast, visit) {
  visit(ast);
  for (const child of [ast.a, ast.b, ...(ast.args || [])]) if (child) walk(child, visit);
}

// Null when a pull request's runner and this PC know the same value for a reference;
// otherwise why not.
export function unknown(ref) {
  if (/^(?:github\.(?:event_name|event\.pull_request\.(?:base|head)\.sha|sha|event\.before|ref|head_ref|base_ref|repository|repository_owner|event\.repository\.default_branch|workspace|action_path|actor|run_id|run_number|run_attempt)|runner\.(?:os|temp|arch)|env\.[\w-]+|inputs\.[\w-]+|steps\.[\w-]+\.(?:outputs\.[\w-]+|outcome|conclusion)|needs\.[\w-]+\.(?:outputs\.[\w-]+|result))$/.test(ref)) return null;
  const secret = ref.match(/^secrets\.([\w-]+)$/);
  if (secret) return `needs the secret ${secret[1]}`;
  return `reads ${ref}`;
}

// Why an expression can't be worked out here, or null.
function expressionWhy(source) {
  let ast;
  try { ast = parse(source); } catch { return `reads \${{ ${source} }}`; }
  let why = null;
  walk(ast, node => {
    if (why) return;
    if (node.call && !calls.has(node.call)) why = `calls ${node.call}()`;
    if (node.ref) why = unknown(node.ref);
  });
  return why;
}

const embedded = value => [...String(value).matchAll(/\$\{\{\s*(.*?)\s*\}\}/gs)].map(m => m[1]);
function strings(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value).flatMap(strings);
  return [String(value)];
}
function references(...values) {
  for (const value of values.flatMap(strings)) for (const source of embedded(value)) {
    const why = expressionWhy(source);
    if (why) return why;
  }
  return null;
}

// An `if:`, with or without ${{ }}: its expression, and whether it names a status itself.
export function condition(expression) {
  if (expression === undefined || expression === null || expression === '') return {ast: {lit: true}, status: false};
  if (typeof expression === 'boolean') return {ast: {lit: expression}, status: false};
  const trimmed = String(expression).trim();
  const source = trimmed.match(/^\$\{\{\s*(.*?)\s*\}\}$/s)?.[1] ?? trimmed;
  const why = expressionWhy(source);
  if (why) return {why: `its condition ${why}`};
  const ast = parse(source);
  let status = false;
  walk(ast, node => { if (node.call && statusCalls.has(node.call)) status = true; });
  return {ast, status};
}

const truthy = v => !(v === '' || v === 0 || v === false || v === null || v === undefined);
const text = v => v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
function equal(a, b) {
  if (typeof a === typeof b && typeof a !== 'string') return a === b;
  return text(a).toLowerCase() === text(b).toLowerCase();
}

function evaluate(ast, ctx, failed) {
  if ('lit' in ast) return ast.lit;
  if (ast.ref) return resolve(ast.ref, ctx);
  const e = node => evaluate(node, ctx, failed);
  if (ast.call) {
    const args = ast.args.map(e);
    switch (ast.call) {
      case 'always': return true;
      case 'success': return !failed;
      case 'failure': return failed;
      case 'cancelled': return false;
      case 'contains': return text(args[0]).toLowerCase().includes(text(args[1]).toLowerCase());
      case 'startsWith': return text(args[0]).toLowerCase().startsWith(text(args[1]).toLowerCase());
      case 'endsWith': return text(args[0]).toLowerCase().endsWith(text(args[1]).toLowerCase());
      case 'format': return text(args[0]).replace(/\{(\d+)\}/g, (_, n) => text(args[Number(n) + 1]));
    }
  }
  switch (ast.op) {
    case '!': return !truthy(e(ast.a));
    case '&&': { const a = e(ast.a); return truthy(a) ? e(ast.b) : a; }
    case '||': { const a = e(ast.a); return truthy(a) ? a : e(ast.b); }
    case '==': return equal(e(ast.a), e(ast.b));
    case '!=': return !equal(e(ast.a), e(ast.b));
    case '<': return Number(e(ast.a)) < Number(e(ast.b));
    case '>': return Number(e(ast.a)) > Number(e(ast.b));
    case '<=': return Number(e(ast.a)) <= Number(e(ast.b));
    case '>=': return Number(e(ast.a)) >= Number(e(ast.b));
  }
  throw new Error('ci-check: an expression it could not read');
}

function resolve(ref, ctx) {
  const [head, ...rest] = ref.split('.');
  if (head === 'github') {
    return {
      event_name: 'pull_request', 'event.pull_request.base.sha': ctx.base, 'event.pull_request.head.sha': ctx.head, sha: ctx.head,
      'event.before': '', ref: 'refs/pull/0/merge', head_ref: ctx.headRef, base_ref: ctx.branch, repository: ctx.repository,
      repository_owner: text(ctx.repository).split('/')[0], 'event.repository.default_branch': ctx.branch, workspace: ctx.root,
      action_path: ctx.actionPath, actor: '', run_id: String(process.pid), run_number: '0', run_attempt: '1',
    }[rest.join('.')] ?? '';
  }
  if (head === 'runner') {
    const system = ctx.platform === 'win32' ? 'Windows' : ctx.platform === 'darwin' ? 'macOS' : 'Linux';
    return {os: system, temp: ctx.temp, arch: process.arch === 'arm64' ? 'ARM64' : 'X64'}[rest[0]] ?? '';
  }
  if (head === 'env') return ctx.env?.[rest[0]] ?? '';
  if (head === 'inputs') return ctx.inputs?.[rest[0]] ?? '';
  if (head === 'steps') return rest[1] === 'outputs' ? ctx.steps?.[rest[0]]?.outputs?.[rest[2]] ?? '' : ctx.steps?.[rest[0]]?.outcome ?? '';
  if (head === 'needs') return rest[1] === 'result' ? ctx.needs?.[rest[0]]?.result ?? '' : ctx.needs?.[rest[0]]?.outputs?.[rest[2]] ?? '';
  throw new Error(`ci-check can't read ${ref}`);
}
const fill = (value, ctx) => String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/gs, (_, e) => text(evaluate(parse(e), ctx, false)));
const fillAll = (map, ctx) => Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [k, fill(v, ctx)]));
// A step runs when its condition holds; without a status function it also needs every
// step before it to have passed.
function holds(cond, ctx, failed) {
  if (!cond.status && failed) return false;
  return truthy(evaluate(cond.ast, ctx, failed));
}

// --- Planning ---

function osOf(runsOn) {
  const labels = [].concat(runsOn ?? []).map(String).join(' ').toLowerCase();
  return labels.includes('windows') ? 'win32' : labels.includes('macos') ? 'darwin' : 'linux';
}
const label = runsOn => [].concat(runsOn ?? []).join(', ');

// One command with no shell syntax, not even a variable set before it.
const plain = /^[\w@%+:,./-]+(?:[ \t]+[\w@%+=:,./-]+)*$/;

function onPath(program) {
  if (path.isAbsolute(program) || program.includes('/')) return true;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return (process.env[key] || '').split(path.delimiter).filter(Boolean)
    .some(dir => exts.some(ext => {
      // Windows' app aliases (WindowsApps\python3.exe) are links only lstat can read.
      try { const s = fs.lstatSync(path.join(dir, program + ext)); return s.isFile() || s.isSymbolicLink(); } catch { return false; }
    }));
}

function readAction(dir) {
  for (const name of ['action.yml', 'action.yaml']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const found = YAML.parse(fs.readFileSync(file, 'utf8'));
    return found?.runs?.using === 'composite' ? {...found, dir} : null;
  }
  return null;
}

// What a `uses:` step is here: the checkout ci-check runs in, a toolchain setup the PC's
// own tools stand in for, a check the default suite runs, a composite action to run, or
// why it can't be any of those.
export function action(uses, {root, repository, step = {}}) {
  uses = String(uses);
  if (/^actions\/checkout@/.test(uses)) {
    const w = step.with || {};
    if (w.repository && String(w.repository).toLowerCase() !== String(repository).toLowerCase()) return {why: `checks out ${w.repository}`};
    if (w.ref || w.path) return {why: 'checks out another commit or folder'};
    return {kind: 'checkout'};
  }
  const shared = uses.match(/^romaine-life\/pipeline-templates\/actions\/([\w-]+)@(.+)$/);
  if (shared && provisioning.has(shared[1]) || /^actions\/setup-[\w-]+@/.test(uses)) return {kind: 'toolchain'};
  if (shared && shared[1] === 'check-fetches') return {kind: 'covered'};
  if (shared) {
    if (shared[2] !== 'main') return {why: `uses ${uses}, and ci-check holds pipeline-templates' main`};
    const found = readAction(path.join(templates, 'actions', shared[1]));
    return found ? {kind: 'composite', action: found} : {why: `uses ${uses}, which isn't a composite action`};
  }
  if (uses.startsWith('./')) {
    const name = uses.replace(/^\.\/actions\//, '').replace(/\/$/, '');
    if (provisioning.has(name) && name !== 'suite') return {why: `sets up the runner's machine (${uses})`};
    const found = readAction(path.join(root, uses));
    return found ? {kind: 'composite', action: found} : {why: `uses ${uses}, which isn't a composite action`};
  }
  return {why: `uses ${uses}`};
}

// Why a list of steps can't run here, or null.
function stepsWhy(steps, {root, repository, depth = 0}) {
  const toolchains = new Set();
  for (const step of steps || []) {
    const cond = condition(step.if);
    if (cond.why) return cond.why;
    const why = references(step.env, step.with, step.run, step['working-directory']);
    if (why) return why;
    const read = strings([step.env, step.with, step.run, step.if])
      .flatMap(v => [...v.matchAll(/steps\.([\w-]+)\.outputs/g)].map(m => m[1])).find(id => toolchains.has(id));
    if (read) return `reads what its toolchain setup step ${read} reports`;
    if (step.uses) {
      const found = action(step.uses, {root, repository, step});
      if (found.why) return found.why;
      if (found.kind === 'toolchain' && step.id) toolchains.add(step.id);
      if (found.kind === 'composite') {
        if (depth > 8) return `nests ${step.uses} too deep`;
        const inner = stepsWhy(found.action.runs.steps, {root, repository, depth: depth + 1});
        if (inner) return `${step.uses} ${inner}`;
      }
      continue;
    }
    if (step.run === undefined) return 'has a step with neither run nor uses';
    // As the suites leave service tests and image builds to the runner's Docker; and nothing
    // here changes the PC's own system.
    if (/\b(?:docker|podman|buildah)\b/.test(step.run)) return "runs containers, which the runner's Docker does";
    if (/(?:^|[\s;&|(])(?:sudo|apt-get|apt|dnf|yum|apk)\s/m.test(step.run)) return "changes the runner's system";
    const command = String(step.run).trim();
    if (plain.test(command) && !onPath(command.split(/\s+/)[0])) return `needs ${command.split(/\s+/)[0]}, which isn't on PATH here`;
  }
  return null;
}

const sameSteps = (a, b) => JSON.stringify((a.steps || []).map(({shell, ...s}) => s)) === JSON.stringify((b.steps || []).map(({shell, ...s}) => s))
  && JSON.stringify(a.if ?? null) === JSON.stringify(b.if ?? null);

// The jobs of one workflow, each after the jobs it needs, with `why` when one is left to
// the pull request. A job for another system is `tried`: it runs here, its passing counts,
// and its failing may be that system's, so the pull request decides it. One whose twin for
// this system runs the same steps is that twin's run.
export function planWorkflow(workflow, {root, repository, platform = process.platform, name = 'workflow'}) {
  const jobs = Object.entries(workflow.jobs || {}).map(([id, job]) => ({id, job, name: `${workflow.name || name} / ${id}`,
    needs: [].concat(job.needs ?? []).map(String), os: osOf(job['runs-on'])}));
  const byId = Object.fromEntries(jobs.map(j => [j.id, j]));
  for (const j of jobs) {
    const {job} = j;
    j.cond = condition(job.if);
    if (j.cond.why) j.why = j.cond.why;
    else if (job.uses) j.why = `calls ${job.uses}`;
    else if (job.strategy?.matrix) j.why = 'is a matrix job';
    else if (job.container || job.services) j.why = 'runs in containers';
    else j.why = references(workflow.env, workflow.defaults, job.env, job.outputs, job.defaults, job['runs-on'])
      || stepsWhy(job.steps, {root, repository});
    for (const need of j.needs) if (!byId[need]) j.why ??= `needs ${need}, which isn't in the workflow`;
    j.tried = j.os !== platform;
  }
  for (const j of jobs) {
    if (j.os === platform) continue;
    const twin = jobs.find(t => t !== j && t.os === platform && !t.why && sameSteps(t.job, j.job));
    if (twin) j.why = `runs on ${label(j.job['runs-on'])}; ${twin.id} runs the same steps here`;
  }
  const ordered = [], seen = new Set();
  const visit = (j, stack = new Set()) => {
    if (seen.has(j.id)) return;
    if (stack.has(j.id)) { j.why ??= 'is in a needs cycle'; return; }
    stack.add(j.id);
    for (const need of j.needs) if (byId[need]) visit(byId[need], stack);
    seen.add(j.id); ordered.push(j);
  };
  for (const j of jobs) visit(j);
  return ordered;
}

// --- Running ---

function readKeyFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^=]+)<<(.+)$/);
    if (heredoc) {
      const body = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]);
      out[heredoc[1]] = body.join('\n');
    } else if (lines[i].includes('=')) {
      const at = lines[i].indexOf('=');
      out[lines[i].slice(0, at)] = lines[i].slice(at + 1);
    }
  }
  return out;
}

// Git for Windows' bash, never the WSL launcher that System32 puts on PATH.
function bash() {
  if (process.platform !== 'win32') return 'bash';
  const file = path.resolve(capture('git', ['--exec-path']), '..', '..', '..', 'bin', 'bash.exe');
  if (!fs.existsSync(file)) throw new Error("bash steps need Git for Windows' bash");
  return file;
}

// Splits a custom `shell:` line into its program and arguments, quoted as a POSIX shell reads them.
export function words(line) {
  const out = [];
  let word = null, quote = null;
  for (const c of line) {
    if (quote) { if (c === quote) quote = null; else word += c; }
    else if (c === '"' || c === "'") { quote = c; word ??= ''; }
    else if (/\s/.test(c)) { if (word !== null) out.push(word); word = null; }
    else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}

// The program and arguments a step's shell runs its script with, as the runner starts it;
// PowerShell loads no profile, as the runner's has none.
export function shellCommand(shell, script, dir, jobOS) {
  const name = shell || (jobOS === 'win32' ? 'pwsh' : 'bash');
  const kind = /^(?:pwsh|powershell)\b/.test(name) ? 'ps' : /^cmd\b/.test(name) ? 'cmd' : /^(?:bash|sh)\b/.test(name) ? 'sh' : null;
  if (!kind) throw new Error(`ci-check can't run the shell ${name}`);
  const file = path.join(dir, `step-${process.hrtime.bigint()}.${{ps: 'ps1', cmd: 'cmd', sh: 'sh'}[kind]}`);
  if (name.includes('{0}')) {
    fs.writeFileSync(file, script);
    const [program, ...args] = words(name).map(w => w.replaceAll('{0}', file));
    return {file: program === 'bash' ? bash() : program, args};
  }
  if (kind === 'ps') {
    fs.writeFileSync(file, `$ErrorActionPreference = 'stop'\n${script}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`);
    return {file: name.split(/\s+/)[0], args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `. '${file}'`]};
  }
  fs.writeFileSync(file, script);
  if (kind === 'cmd') return {file: 'cmd', args: ['/D', '/E:ON', '/V:OFF', '/S', '/C', `CALL "${file}"`]};
  if (name.split(/\s+/)[0] === 'sh') return {file: 'sh', args: ['-e', file]};
  return {file: bash(), args: shell ? ['--noprofile', '--norc', '-eo', 'pipefail', file] : ['-e', file]};
}

// PATH as the runner has it after GITHUB_PATH: the added folders first, then this PC's.
function withPath(env, add) {
  if (!add.length) return env;
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return {...env, [key]: [...add, process.env[key] || ''].join(path.delimiter)};
}

// Runs steps as the runner would: env files carried forward, a failure skipping what
// follows unless a step's condition names a status. Returns whether a step failed.
function runSteps(steps, ctx, shellDefault, failed = false) {
  for (const step of steps || []) {
    if (!holds(condition(step.if), ctx, failed)) continue;
    let ok = true, outputs = {};
    if (step.uses) {
      const found = action(step.uses, {root: ctx.root, repository: ctx.repository, step});
      if (found.kind === 'composite') {
        const inputs = Object.fromEntries(Object.entries(found.action.inputs || {}).map(([k, v]) => [k, text(v?.default)]));
        Object.assign(inputs, fillAll(step.with, ctx));
        const inner = {...ctx, actionPath: found.action.dir, inputs, steps: {}};
        ok = !runSteps(found.action.runs.steps, inner, undefined, false);
        ctx.env = inner.env; ctx.path = inner.path;
        outputs = Object.fromEntries(Object.entries(found.action.outputs || {}).map(([k, v]) => [k, fill(v?.value ?? '', inner)]));
      }
    } else {
      const files = Object.fromEntries(['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH'].map(k => [k, path.join(ctx.temp, `${k}-${process.hrtime.bigint()}`)]));
      for (const f of Object.values(files)) fs.writeFileSync(f, '');
      const stepEnv = fillAll(step.env, ctx);
      const env = withPath({...ctx.env, ...stepEnv, ...files, GITHUB_ACTION_PATH: ctx.actionPath ?? ''}, ctx.path);
      try {
        const cmd = shellCommand(step.shell || shellDefault, fill(step.run, {...ctx, env: {...ctx.env, ...stepEnv}}), ctx.temp, ctx.jobOS);
        run(cmd.file, cmd.args, {cwd: path.resolve(ctx.root, fill(step['working-directory'] || '.', ctx)), env});
      } catch (e) {
        ok = false;
        console.log(`ci-check: step "${step.name || String(step.run).trim().split('\n')[0]}": ${e.message}`);
      }
      ctx.env = {...ctx.env, ...readKeyFile(files.GITHUB_ENV)};
      ctx.path = [...fs.readFileSync(files.GITHUB_PATH, 'utf8').split(/\r?\n/).filter(Boolean).reverse(), ...ctx.path];
      outputs = readKeyFile(files.GITHUB_OUTPUT);
    }
    if (step.id) ctx.steps[step.id] = {outputs, outcome: ok ? 'success' : 'failure'};
    if (!ok && !step['continue-on-error']) failed = true;
  }
  return failed;
}

// Runs one planned job; returns its outputs, or throws when a step failed.
export function runJob(planned, workflow, context) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-check-job-'));
  const ctx = {...context, temp, jobOS: planned.os, steps: {}, path: [], env: {}};
  try {
    ctx.env = {
      CI_CACHE_ROOT: process.env.CI_CACHE_ROOT || cacheRoot(), GITHUB_WORKSPACE: ctx.root, RUNNER_TEMP: temp,
      RUNNER_OS: resolve('runner.os', ctx), GITHUB_EVENT_NAME: 'pull_request', BASE: ctx.base,
    };
    ctx.env = {...ctx.env, ...fillAll(workflow.env, ctx)};
    ctx.env = {...ctx.env, ...fillAll(planned.job.env, ctx)};
    const job = planned.job;
    if (runSteps(job.steps, ctx, job.defaults?.run?.shell || workflow.defaults?.run?.shell)) throw new Error('a step failed');
    return fillAll(job.outputs, ctx);
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

// Every job the repository's own workflows would start on the pull request, run here or
// named. A job whose condition comes out false, or that follows one that didn't start,
// isn't started by the pull request either, so it isn't named.
export function runOwn({root, repository, base, branch, files, platform = process.platform}) {
  const out = {ran: 0, failed: [], skipped: []};
  const dir = workflowFolder(root);
  if (!dir) return out;
  const head = capture('git', ['rev-parse', 'HEAD'], {cwd: root});
  const headRef = capture('git', ['branch', '--show-current'], {cwd: root});
  const context = {root, repository, base, branch, head, headRef, platform};
  for (const file of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    let workflow;
    try { workflow = YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { out.skipped.push(`${file}: ci-check can't read it: ${e.message}`); continue; }
    if (!workflow?.on || !starts(workflow.on, files, branch)) continue;
    const state = {};
    for (const j of planWorkflow(workflow, {root, repository, platform, name: file})) {
      const status = j.cond.status;
      const failedNeed = j.needs.find(n => ['failed', 'after-failure'].includes(state[n]?.state));
      if (failedNeed && !status) { state[j.id] = {state: 'after-failure'}; out.skipped.push(`${j.name}: not run, since ${failedNeed} failed`); continue; }
      if (!status && j.needs.some(n => state[n]?.state === 'not-started')) { state[j.id] = {state: 'not-started'}; continue; }
      const reads = [...(j.cond.ast ? [JSON.stringify(j.cond.ast)] : []), ...strings(j.job).flatMap(embedded)]
        .flatMap(e => [...e.matchAll(/needs\.([\w-]+)\./g)].map(m => m[1]));
      const unread = reads.find(n => state[n]?.state !== 'ran');
      const needs = Object.fromEntries(j.needs.map(n => [n, {outputs: state[n]?.outputs || {}, result: state[n]?.state === 'ran' ? 'success' : 'skipped'}]));
      if (!j.cond.why && !unread && !truthy(evaluate(j.cond.ast, {...context, needs}, Boolean(failedNeed)))) {
        state[j.id] = {state: 'not-started'}; continue;
      }
      const why = j.why || (unread && `reads ${unread}'s outputs, and ${unread} runs on the pull request only`);
      if (why) { state[j.id] = {state: 'left'}; out.skipped.push(`${j.name}: ${why}`); continue; }
      console.log(`\n== ${j.name}${j.tried ? ` (a ${label(j.job['runs-on'])} job, tried here)` : ''}`);
      try {
        state[j.id] = {state: 'ran', outputs: runJob(j, workflow, {...context, needs})};
        out.ran++;
      } catch (error) {
        if (j.tried) {
          state[j.id] = {state: 'left'};
          out.skipped.push(`${j.name}: runs on ${label(j.job['runs-on'])} and failed on this PC (${error.message}); the pull request decides`);
        } else {
          state[j.id] = {state: 'failed'};
          out.ran++;
          out.failed.push(`${j.name}: ${error.message}`);
        }
      }
    }
  }
  return out;
}
