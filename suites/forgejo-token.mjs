// A CI job's short-lived Forgejo token for repositories (SES-267), in place of a stored
// one. Forgejo's authorized integrations (nelsong6/forgejo README, Package sign-in) take the
// job's own OIDC token for their audience; each limits which jobs it admits and what the
// token may do. The job sets enable-openid-connect: true. The token lasts an hour, so
// it is made in the step before the one that uses it (actions/forgejo-token).
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

// The integrations' audiences, which Forgejo made (nelsong6/forgejo README).
export const audiences = {
  // read:repository, for any nelsong6/* or romaine-life/* job.
  read: 'u:1:c769ea44-a98d-42ca-a2c1-a0471d822ae9',
  // write:repository and write:issue, for the suites' release, deploy and dependency
  // workflows and a release part's build.yml, on main or master (push or dispatch).
  write: 'u:1:a9240048-3b8f-42a0-b7ce-e592cd75d441',
  // write:repository, for pipeline-templates' fleet.yml and tofu-providers.yml.
  'romaine-life/pipeline-templates': 'u:1:ea00c132-73be-459f-ab1f-f0c02dba494d',
};

// The audience for an access level in a repository: a repository with its own write
// integration uses it.
export function audience(access, repository = process.env.GITHUB_REPOSITORY) {
  if (access === 'read') return audiences.read;
  if (access !== 'write') throw new Error(`access is read or write, not ${access}`);
  return audiences[repository] ?? audiences.write;
}

// The job's own token for an audience.
export async function jobToken(aud, env = process.env) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('the job needs enable-openid-connect: true for a Forgejo token');
  const response = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(aud)}`, {
    headers: {Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`job token: HTTP ${response.status}`);
  return (await response.json()).value;
}

// The action: the token as the step's output `token`, masked in the log.
export async function main(access, env = process.env) {
  const token = await jobToken(audience(access, env.GITHUB_REPOSITORY), env);
  console.log(`::add-mask::${token}`);
  fs.appendFileSync(env.GITHUB_OUTPUT, `token=${token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
