import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';

export const suites = path.dirname(fileURLToPath(import.meta.url));
export const templates = path.dirname(suites);
export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {stdio: 'inherit', ...options, env: {...process.env, ...options.env,
    GOMAXPROCS: '4', CARGO_BUILD_JOBS: '4', CMAKE_BUILD_PARALLEL_LEVEL: '4', DOTNET_PROCESSOR_COUNT:'4', UV_CONCURRENT_BUILDS:'4', OMP_NUM_THREADS:'4', OPENBLAS_NUM_THREADS:'4'}});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return options.encoding ? result.stdout.trim() : undefined;
}
export const capture = (command, args, options = {}) => run(command, args, {stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options});
export const tracked = () => capture('git', ['ls-files', '-z']).split('\0').filter(Boolean);
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function output(name, value) {
  if (/\r|\n/.test(String(value))) throw new Error(`multiline output: ${name}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}
export function cacheRoot() {
  return path.resolve(process.env.CI_CACHE_ROOT || (process.platform === 'win32' && process.env.GITHUB_ACTIONS
    ? 'D:/ci/cache' : path.join(process.env.RUNNER_TOOL_CACHE || path.join(os.homedir(), '.cache'), 'ci-suites')));
}
export function kept(name) {
  const dir = path.join(cacheRoot(), name);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}
export async function request(url, {token = process.env.TOKEN, method = 'GET', body, headers = {}, allow404 = false, text = false} = {}) {
  if (!token) throw new Error('missing API token');
  const response = await fetch(url, {method, headers: {Authorization: `token ${token}`, ...headers}, body,
    signal: AbortSignal.timeout(30000)});
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    let message='';try {const error=await response.json();if(typeof error.message==='string')message=`: ${error.message.slice(0,500)}`;}catch {}
    throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}${message}`);
  }
  const value=await response.text();
  return text ? value : value ? JSON.parse(value) : null;
}
export const api = () => `${process.env.GITHUB_SERVER_URL}/api/v1/repos/${process.env.GITHUB_REPOSITORY}`;
export const post = (url, body, options = {}) => request(url, {...options, method: 'POST',
  headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
export function publishEvent(event = process.env.GITHUB_EVENT_NAME, ref = process.env.GITHUB_REF, branch = process.env.DEFAULT_BRANCH) {
  return ['push', 'workflow_dispatch'].includes(event) && ref === `refs/heads/${branch}`;
}
export function requirePublish() {
  if (!publishEvent()) throw new Error('publishing requires push/dispatch of the default branch');
}
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error(`expected repository-relative path: ${value}`);
  }
  return value;
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
