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
| `go`, `rust`, `cmake`, `dotnet`, `python` | `platforms`: the platforms tests run on (default `ubuntu-latest`; list it beside `windows-latest` to keep Linux) |
| `go` | `dependencies`: modules taken up through `go/dependencies.yml`; `race`: packages whose tests also run under the race detector, in the Linux test job (so `platforms` must include `ubuntu-latest`) |
| `rust` | `features`, `noDefaultFeatures`, `platformFeatures`, `lints`: any of `typos`, `machete` and `audit` (RustSec's advisories, read fresh through Artifact Keeper, when `Cargo.lock` changes) |
| `service` | `postgres`, `manticore`, `greenmail`: digest-pinned images the tests need. The tests get `DATABASE_URL`, `MANTICORE_URL`, or GreenMail's `SMTP_HOST`, `IMAP_HOST` and `POP3_HOST` (one address) with `SMTP_PORT`, `IMAP_PORT`, `POP3_PORT` and, over TLS, `SMTPS_PORT`, `IMAPS_PORT`, `POP3S_PORT`, and `GREENMAIL_CERT`: a file holding the certificate GreenMail presents |
| `greenmail` | `users`: GreenMail's accounts, each `login:password@domain`, signing in with the whole address |
| `release` | `toolchains`, `prefix` or `prefixFrom`, `homeSync`, `goTargets`, `windowsGui`, `rustTargets` (each `{target, features, noDefaultFeatures, glibc}`: a Linux target with a `glibc` floor such as `2.35` builds through zig, which another architecture than the runner's x86_64 needs; Windows ARM64 builds with the Windows runner's LLVM clang), `dependencies` (each `{url, sha256 or lock, destination}`; `extract` takes one file out of a downloaded archive, a 7z included on a Windows build), `assets`, `image` |
| `release` (a Go library) | `module: true`: a merge that changes the code takes the next tag and publishes it with its source, building nothing; consumers take it up through their `go.dependencies` |
| `cluster` | `renders`, `build`, `image`, `context`: the image's build context, where its `Dockerfile` is (the repository root by default), `baoRole`, `baoSecret`, `pinFile`, `pinFields` |
| `web` | `packages`, `node`, `image`, `pinFile`, `pinFields`, `containerApp`, `resourceGroup`, `staticApp`, `history`: the tests compare with the base branch, so the test job gets full history (`origin/<base>`), `dependencies`: inputs from other repositories, each `{repository, asset or path, destination}`, pinned in `dependencies.lock` and staged before the image builds, and before each `release.toolchains` target builds (fzt-desktop embeds them in its executable); the source's `release.dispatch` to `web-app/dependencies.yml`, or `release/dependencies.yml` for a release, proposes its newest release as a take-up PR |
| `tofu` | `version`, `backend` |
| `docs` | `required`, `release` |
| `powershell` | `windowsPowerShell` |
| `inputs` | extra file patterns per check (`"go.test": ["assets/**"]`) |

A few things come from the repository rather than the list: its Rust toolchain is its
`rust-toolchain.toml` (channel and components), as rustup reads it, else the pinned stable;
and a Windows `c-shared` Go build fails if it imports a MinGW runtime DLL (`lib*.dll`), which
nothing ships beside it.

## An image joined to a release

A release with `release.image: cluster` publishes the cluster image and proposes its pin.
The image is built again only when its inputs (its `Dockerfile`, `.dockerignore` and what it
copies in) changed since the release that built the image the pin file runs; otherwise the
release keeps that image, and its pin PR moves only the `pinFields`, so the pod isn't
restarted. On a PR the image's `--self-test` runs with the assembled release at `/ci/dist`,
in a layer only the check runs, for an image that runs a release binary it doesn't hold.

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
   workflows: these rules, and actionlint, so a workflow Forgejo would refuse (a context
   used where it isn't available, an unknown key) fails on the pull request rather than
   when Forgejo first runs it.

## Suites

`default`, `go`, `rust`, `cmake`, `dotnet`, `python`, `release`, `cluster-service`,
`web-app`, `tofu`, `docs`, `powershell`. Each `suites/<suite>/ci.yml` has a `scope` job that
decides from the PR's diff which checks run, and runs the scripts beside it. The Rust test jobs
have uv on PATH, for tests that compare a port with the Python it replaces.

## Before a push

`ci-check` (at-home-tools) runs `suites/check.mjs` in a repository's worktree: for the
commits since the default branch, the check jobs its suites' pull-request run would start,
through the same scripts. It reads each suite's `ci.yml` for the jobs, their conditions
and their commands, so a suite change reaches it with no edit there. A test job runs only on
its own platform, and a few jobs run on the pull request only, each with the reason
`check.mjs` gives (`ciOnly`): image builds, release builds and packaging, OpenTofu plans,
and tests that need services on the runner's Docker network.
