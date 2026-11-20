// ci-check (at-home-tools) runs this from a repository's worktree before a push: the
// checks its suites' pull-request run would start for the commits since the default
// branch, through the same scripts. Each suite's ci.yml is read for its check jobs, their
// conditions and their commands, so nothing here lists what a suite runs; the repository's
// own workflows are read the same way, and each of their jobs runs or is named
// (own-workflows.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {capture, run, suites, templates} from './lib.mjs';
import {config, currentRepository, fleet} from './config.mjs';
import {localToken, readTopics} from './topics.mjs';
import {changed, scope} from './inputs.mjs';
import {runOwn} from './own-workflows.mjs';
import {readToken, usesPackages} from './packages.mjs';

// Check jobs a PC doesn't run; the pull request runs them.
export const ciOnly = {
  'cluster-service/check-image': 'builds and smoke-tests the container image',
  'web-app/check-image': 'builds and smoke-tests the container image',
  'release/check-build': 'builds every release target',
  'release/check-package': 'packages and signs the release',
  'tofu/check-plan': "plans against live state as CI's identity",
};
// A test job runs on its own platform: Linux tests aren't run on Windows, nor the reverse.
const pinned = new Set(['test-linux', 'test-windows', 'service-test', 'parse-legacy']);

export function condition(expression) {
  const terms = [];
  for (const part of String(expression).split('&&').map(s => s.trim())) {
    if (part === "github.event_name == 'pull_request'") continue;
    const term = part.match(/^needs\.scope\.outputs\.([\w-]+) == '([^']*)'$/);
    if (!term) throw new Error(`ci-check can't read the job condition: ${part}`);
    terms.push({name: term[1], value: term[2]});
  }
  return terms;
}

export function command(step) {
  const parts = step.run.trim().split(/\s+/);
  const node = parts[0] === 'node';
  const [script, ...args] = node ? parts.slice(1) : parts;
  if (!/^(?:\.\/)?_ci\/suites\/[\w/.-]+\.(?:mjs|ps1)$/.test(script) || node !== script.endsWith('.mjs') || args.some(a => !/^[\w-]+$/.test(a))) {
    throw new Error(`ci-check can't run the step: ${step.run}`);
  }
  const file = path.join(templates, script.replace(/^(?:\.\/)?_ci\//, ''));
  if (node) return {file: process.execPath, args: [file, ...args]};
  return {file: /^powershell\b/.test(step.shell || '') ? 'powershell' : 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file, ...args]};
}

// The suite's check jobs this change starts, each with its commands or why a PC skips it.
export function plan(suite, outputs, cfg, platform = process.platform) {
  const workflow = YAML.parse(fs.readFileSync(path.join(suites, suite, 'ci.yml'), 'utf8'));
  const jobs = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!id.startsWith('check-')) continue;
    const name = `${suite}/${id}`, terms = condition(job.if);
    if (!terms.every(t => (outputs[t.name] ?? '') === t.value)) continue;
    const on = job['runs-on'] === 'windows-latest' ? 'win32' : 'linux';
    const services = job.steps.some(s => /suites\/services\.mjs start/.test(s.run || ''));
    if (ciOnly[name]) jobs.push({name, skip: ciOnly[name]});
    else if (terms.some(t => pinned.has(t.name)) && on !== platform) jobs.push({name, skip: `runs on ${job['runs-on']}`});
    else if (services && Object.keys(cfg.service || {}).length) jobs.push({name, skip: "its test services run on the runner's Docker network"});
    else jobs.push({name, steps: job.steps.filter(s => s.run).map(s => ({...command(s), always: s.if === 'always()'}))});
  }
  return jobs;
}

// The branch the pull request would go into: origin's default.
export function defaultBranch() {
  const head = capture('git', ['ls-remote', '--symref', 'origin', 'HEAD']).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  if (!head) throw new Error("origin doesn't name its default branch");
  return head[1];
}

// The commit the pull request would be compared with: where HEAD leaves the default branch.
export function base(branch = defaultBranch()) {
  run('git', ['fetch', '--quiet', 'origin', branch]);
  return capture('git', ['merge-base', 'HEAD', 'FETCH_HEAD']);
}

async function outputs(suite) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-check-')), 'outputs');
  const saved = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  try {
    await scope(suite);
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
  } finally {
    if (saved === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved;
    fs.rmSync(path.dirname(file), {recursive: true, force: true});
  }
}

export async function check({platform = process.platform, branch, from} = {}) {
  if (!from) from = base(branch ??= defaultBranch());
  process.env.BASE = from;
  // The repository's topics, read from Forgejo with this PC's sign-in, as the suite action
  // reads them with the job's token in CI; the scripts below inherit them. A Go repository's
  // are read listed or not: the default suite's rules check it takes the go suite.
  const repository = currentRepository();
  if (process.env.CI_TOPICS === undefined && (fleet()[repository] || fs.existsSync('go.mod'))) process.env.CI_TOPICS = JSON.stringify(await readTopics(repository, {token: localToken()}));
  // npm packages from Forgejo, read with the token OpenBao signs for this PC, as CI reads
  // them with the job's own (packages.mjs).
  if (process.env.FORGEJO_PACKAGES_TOKEN === undefined && usesPackages()) process.env.FORGEJO_PACKAGES_TOKEN = await readToken();
  const cfg = config();
  const failed = [], skipped = [];
  let ran = 0;
  for (const suite of ['default', ...cfg.suites]) {
    for (const job of plan(suite, await outputs(suite), cfg, platform)) {
      if (job.skip) { skipped.push(`${job.name}: ${job.skip}`); continue; }
      console.log(`\n== ${job.name}`);
      ran++;
      let error;
      for (const step of job.steps) {
        if (error && !step.always) continue;
        try { run(step.file, step.args); } catch (e) { error ??= e; }
      }
      if (error) failed.push(`${job.name}: ${error.message}`);
    }
  }
  const own = runOwn({root: capture('git', ['rev-parse', '--show-toplevel']), repository, base: from,
    branch: branch ?? 'main', files: changed(from), platform});
  ran += own.ran; failed.push(...own.failed); skipped.push(...own.skipped);
  console.log(`\nci-check: ${ran} check job(s) ran${failed.length ? `, ${failed.length} failed` : ', all passed'}.`);
  for (const line of failed) console.log(`  failed  ${line}`);
  for (const line of skipped) console.log(`  on the PR only  ${line}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await check();
