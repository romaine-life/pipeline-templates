# Home CI suites (PIPT-12)

Every home repository's CI comes from here. Our Forgejo build (nelsong6/forgejo, patch
0010) runs, for a repository with `ci-<suite>` topics, the workflows in `suites/<suite>/`
of this repository at `main` (or at the branch its `CI_SUITES_REF` Actions variable names),
always with `default` beside them. A repository keeps no CI files of its own except a
job no suite covers.

## The fleet list

`fleet.json` at this repository's root names every repository on the suites, the suites
it takes, and the few settings a convention can't decide for it. It is the only place a
repository's CI is configured: changing the fleet, or any repository in it, is one PR
here. The `Fleet` workflow aligns every owned repository to it: on a PR it prints what the
merge would change, and the merge changes it.

- A listed repository's `ci-` topics become exactly `ci-<suite>` for each suite listed.
- Its default branch requires each suite's pull-request statuses, `Suite <suite> / *
  (pull_request)`, `default` included.
- A repository the list doesn't name carries no `ci-` topics.

An entry is `{"suites": [...]}` plus any of the settings below. `config.mjs` validates it;
an unknown field fails.

| Section | Fields |
|---|---|
| `go`, `rust`, `cmake`, `dotnet`, `python` | `platforms`: test platforms beyond Linux (`windows-latest`) |
| `rust` | `features`, `noDefaultFeatures`, `platformFeatures`, `lints` |
| `service` | `postgres`, `manticore`, `greenmail`: digest-pinned images the tests need |
| `release` | `toolchains`, `prefix` or `prefixFrom`, `homeSync`, `goTargets`, `windowsGui`, `rustTargets`, `dependencies`, `assets`, `image` |
| `cluster` | `renders`, `build`, `image`, `baoRole`, `baoSecret`, `pinFile`, `pinFields` |
| `web` | `packages`, `node`, `image`, `pinFile`, `pinFields`, `containerApp`, `resourceGroup`, `staticApp` |
| `tofu` | `version`, `backend` |
| `docs` | `required`, `release` |
| `powershell` | `windowsPowerShell` |
| `inputs` | extra file patterns per check (`"go.test": ["assets/**"]`) |

## The rules every suite keeps

1. A check runs on the pull request only. A merge builds, publishes and deploys; it checks
   nothing again. A check whose inputs are identical to a passing run's reuses it.
2. A check runs only when files it reads changed (`input-patterns.mjs`, plus Go embeds,
   Rust includes, Dockerfile `COPY` sources and linked docs).
3. Builds keep their caches on the runners (Go, Cargo per repository and toolchain,
   tools, OpenTofu providers).
4. No job holds a runner while it waits on something else; test services start on the
   job's own Docker network and are ready on Docker's health events.
5. A new push cancels the out-of-date PR run; a run on the default branch is never
   cancelled.
6. `default` runs `check-fetches` and the rules check over a repository's own remaining
   workflows.

## Suites

`default`, `go`, `rust`, `cmake`, `dotnet`, `python`, `release`, `cluster-service`,
`web-app`, `tofu`, `docs`, `powershell`. Each `suites/<suite>/ci.yml` has a `scope` job that
decides from the PR's diff which checks run, and runs the scripts beside it.

## Before a push

`ci-check` (at-home-tools) runs `suites/check.mjs` in a repository's worktree: for the
commits since the default branch, the check jobs its suites' pull-request run would start,
through the same scripts. It reads each suite's `ci.yml` for the jobs, their conditions
and their commands, so a suite change reaches it with no edit there. A test job runs only on
its own platform, and a few jobs run on the pull request only, each with the reason
`check.mjs` gives (`ciOnly`): image builds, release builds and packaging, OpenTofu plans,
and tests that need services on the runner's Docker network.

## Kept for repositories not yet migrated

`.forgejo/workflows/go-dependency-update-template.yml` and
`release-and-dispatch-template.yml` stay byte-identical while unmigrated repositories call
them (`suites/tests/compatibility.test.mjs` guards them); a final PR deletes them once none
does.
