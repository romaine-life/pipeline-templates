// Aligns every owned repository to fleet.json: its ci- topics name exactly its suites, its
// setting topics (topics.mjs) exactly the entry's topics, and its default branch requires
// each suite's pull-request statuses. A repository the list doesn't name carries neither.
// Any other topic (one set by hand) is left as it is. `plan` prints what would change and
// proves the token may write by writing one repository's settings back unchanged; `apply`
// changes them.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {request} from './lib.mjs';
import {fleet} from './config.mjs';
import {isSettingTopic} from './topics.mjs';

const owners = ['romaine-life', 'nelsong6'];
const server = () => (process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life').replace(/\/$/, '');
const api = p => `${server()}/api/v1${p}`;
const send = (method, p, body) => request(api(p), {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

export function topicsFor(current, suites, settings = []) {
  const want = [...current.filter(t => !t.startsWith('ci-') && !isSettingTopic(t)), ...suites.map(s => `ci-${s}`), ...settings].sort();
  if (want.length > 25) throw new Error(`more than Forgejo's 25 topics: ${want.join(' ')}`);
  return want;
}

export function checksFor(suites) {
  return ['default', ...[...suites].sort()].map(s => `Suite ${s} / * (pull_request)`);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function repositories() {
  const found = [];
  for (let page = 1; ; page++) {
    const {data} = await request(api(`/repos/search?limit=50&page=${page}`));
    found.push(...data.filter(r => !r.archived && !r.mirror && owners.includes(r.owner.login)));
    if (data.length < 50) break;
  }
  return found;
}

export async function align(mode, repos = fleet()) {
  if (!['plan', 'apply'].includes(mode)) throw new Error('fleet.mjs plan|apply');
  const all = await repositories();
  const known = new Set(all.map(r => r.full_name));
  for (const name of Object.keys(repos)) if (!known.has(name)) throw new Error(`fleet.json names ${name}, which is not a live repository`);
  let changes = 0;
  for (const repo of all) {
    const suites = repos[repo.full_name]?.suites;
    const {topics} = await request(api(`/repos/${repo.full_name}/topics?limit=50`));
    const want = topicsFor(topics, suites || [], repos[repo.full_name]?.topics);
    if (!same([...topics].sort(), want)) {
      changes++;
      console.log(`${repo.full_name}: topics ${JSON.stringify(topics)} -> ${JSON.stringify(want)}`);
      if (mode === 'apply') await send('PUT', `/repos/${repo.full_name}/topics`, {topics: want});
    }
    if (!suites) continue;
    const rules = await request(api(`/repos/${repo.full_name}/branch_protections`));
    const rule = rules.find(r => (r.rule_name || r.branch_name) === repo.default_branch);
    const checks = checksFor(suites);
    if (rule && rule.enable_status_check && same([...(rule.status_check_contexts || [])].sort(), [...checks].sort())) continue;
    changes++;
    console.log(`${repo.full_name}: required checks ${JSON.stringify(rule?.status_check_contexts || null)} -> ${JSON.stringify(checks)}`);
    if (mode !== 'apply') continue;
    if (rule) await send('PATCH', `/repos/${repo.full_name}/branch_protections/${encodeURIComponent(rule.rule_name || rule.branch_name)}`, {enable_status_check: true, status_check_contexts: checks});
    else await send('POST', `/repos/${repo.full_name}/branch_protections`, {rule_name: repo.default_branch, enable_push: false, enable_status_check: true, status_check_contexts: checks});
  }
  if (mode === 'plan') {
    // The token must be able to write what apply writes: write this repository's own
    // topics back unchanged.
    const self = process.env.GITHUB_REPOSITORY || 'romaine-life/pipeline-templates';
    const {topics} = await request(api(`/repos/${self}/topics`));
    await send('PUT', `/repos/${self}/topics`, {topics});
  }
  console.log(`${changes} change(s) ${mode === 'apply' ? 'made' : 'to make'}`);
  return changes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await align(process.argv[2]);
