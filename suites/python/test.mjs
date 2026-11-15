import path from 'node:path';
import {capture, kept, run} from '../lib.mjs';
import {config} from '../config.mjs';
export function pythonEnvironment(project) {
  const repo=(process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g,'-');
  const version=capture('python',['--version']).replace(/[^\w.-]/g,'-');
  process.env.UV_CACHE_DIR=kept('uv');
  process.env.UV_PROJECT_ENVIRONMENT=kept(`python/${repo}/${version}/${project.replace(/[^\w.-]/g,'-')}/${process.env.GITHUB_JOB || 'local'}`);
}
if (process.argv[1]?.endsWith('/python/test.mjs') || process.argv[1]?.endsWith('\\python\\test.mjs')) {
  for (const cwd of config().python?.projects || ['.']) {
    pythonEnvironment(cwd);
    run('uv',['sync','--frozen','--all-groups'],{cwd});
    run('uv',['run','--frozen','ruff','check','.'],{cwd});
    run('uv',['run','--frozen','ruff','format','--check','.'],{cwd});
    run('uv',['run','--frozen','pytest'],{cwd});
  }
}
