# Home CI suites (PIPT-12)

Every home repository's CI comes from here. Our Forgejo build (nelsong6/forgejo, patch
0010) runs, for a repository with `ci-<suite>` topics, the workflows in `suites/<suite>/`
of this repository at `main` (or at the branch its `CI_SUITES_REF` Actions variable names),
always with `default` beside them. A repository keeps no CI files of its own except a
job no suite covers.

## The fleet list

`fleet.json` at this repository's root names every repository on the suites, the suites
it takes, its setting topics, and the few values a convention can't decide for it yet. It
is the only place a repository's CI is configured: changing the fleet, or any repository in
it, is one PR here. The `Fleet` workflow aligns every owned repository to it: on a PR it
prints what the merge would change, and the merge changes it.

- A listed repository's `ci-` topics become exactly `ci-<suite>` for each suite listed,
  and its setting topics exactly the entry's `topics`.
- Its default branch requires each suite's pull-request statuses, `Suite <suite> / *
  (pull_request)`, `default` included.
- A repository the list doesn't name carries no `ci-` or setting topics.
- Any other topic, one set by hand, is left as it is.

An entry is `{"suites": [...], "topics": [...]}` plus any of the values below. `config.mjs`
validates it; an unknown field or topic fails.

### Setting topics

A CI selection is a property of the repository: one of its Forgejo topics. A suite reads the
running repository's topics from Forgejo's API when it runs, never from the pull request's
checkout, so a change can't alter its own gate: the suite action reads them with the job's
token into `CI_TOPICS` (the suites pass it `token: ${{ github.token }}`), and `ci-check`
reads them with the PC's Forgejo sign-in (`FORGEJO_TOKEN`, else git's credential helper).
A check's fingerprint includes them, so a topic change never reuses an earlier pass.
Without its topic a setting is off. `topics.mjs` lists them.

| Topic | Selects |
|---|---|
| `go-test-linux`, `go-test-windows`, and the same for `rust`, `cmake`, `dotnet`, `python` | The platforms the toolchain's tests run on: Linux with neither, Windows with `-test-windows` alone, both with both |
| `go-race` | Every package's tests run again under the race detector, in the Linux test job |
| `rust-typos`, `rust-machete`, `rust-audit` | Rust lints; `audit` checks RustSec's advisories, read fresh through Artifact Keeper, when `Cargo.lock` changes |
| `windows-powershell` | The PowerShell parse check runs in Windows PowerShell too |
| `service-postgres`, `service-manticore`, `service-greenmail` | The tests' services, each the image `service.<name>` names. The tests get `DATABASE_URL`, `MANTICORE_URL`, or GreenMail's `SMTP_HOST`, `IMAP_HOST` and `POP3_HOST` (one address) with `SMTP_PORT`, `IMAP_PORT`, `POP3_PORT` and, over TLS, `SMTPS_PORT`, `IMAPS_PORT`, `POP3S_PORT`, and `GREENMAIL_CERT`: a file holding the certificate GreenMail presents |
| `cluster-image` | A cluster service builds and smoke-tests its own image, `cluster.image`; without it the service renders and pins what upstream publishes |
| `web-image` | The web app builds the image `web.image` |
| `web-static` | The web app deploys to the Static Web App `web.staticApp` in `web.resourceGroup` |
| `web-history` | The tests compare with the base branch, so the test job gets full history (`origin/<base>`) |
| `release-source` | A documentation repository cuts a source release |
| `release-module` | A Go library: a merge that changes the code takes the next tag and publishes it with its source, building nothing; consumers take it up through their `go.dependencies` |
| `release-go`, `release-rust`, `release-npm`, `release-python`, `release-dotnet`, `release-cmake`, `release-powershell` | The toolchains a release builds |
| `rust-build-windows-amd64`, `rust-build-windows-arm64`, `rust-build-linux-amd64`, `rust-build-linux-arm64` | The Rust release targets; with none, Linux x86_64 |
| `version-from-manifest` | The version series comes from the manifest `release.prefixFrom` names |
| `version-four-part` | Versions take a fourth part, `.0` |
| `home-sync` | A release starts home-sync on every PC |
| `release-archive`, `release-source-list`, `release-external` | The release's archives, source lists and external parts: `release.archives`, `release.sourceLists`, `release.external` |

A value a topic selects is in the entry exactly when the topic is. The values are still in
the list until each becomes a convention or the repository's own file (PIPT-12).

### Values

| Section | Fields |
|---|---|
| `go` | `dependencies`: modules taken up through `go/dependencies.yml` |
| `rust` | `features`, `noDefaultFeatures`, `platformFeatures` |
| `service` | `postgres`, `manticore`, `greenmail`: the digest-pinned image of each service a `service-` topic selects |
| `greenmail` | `users`: GreenMail's accounts, each `login:password@domain`, signing in with the whole address |
| `release` | `prefix` or `prefixFrom`, `goTargets`, `windowsGui`, `goStampPackages`, `rustTargets` (each `{target, package, features, noDefaultFeatures, glibc}`, the values of a target its `rust-build-` topic builds; `package` builds that Cargo package alone with its own default features, for a workspace that ships a different program per platform; a Linux target with a `glibc` floor such as `2.35` builds through zig, which another architecture than the runner's x86_64 needs; Windows ARM64 builds with the Windows runner's LLVM clang), `dependencies` (each `{url, sha256 or lock, destination}`; `extract` takes one file out of a downloaded archive, a 7z included on a Windows build), `assets`, `image`, `archives`, `sourceLists`, `external`, `dispatch`, `mirror`, `dotnetProjects`, `assetNames`, `manifest`, `checksumFiles`, `checksumManifest` |
| `cmake`, `dotnet`, `python` | `buildPlatform`; `dotnet` also `sdk`; `python` also `projects` and `version` |
| `cluster` | `renders`, `image`, `context`: the image's build context, where its `Dockerfile` is (the repository root by default), `baoRole`, `baoSecret`, `pinFile`, `pinFields`, `workPackage` |
| `web` | `packages`, `node`, `image`, `pinFile`, `pinFields`, `workPackage`, `containerApp`, `resourceGroup`, `staticApp`, `dependencies`: inputs from other repositories, each `{repository, asset or path, destination}`, pinned in `dependencies.lock` and staged before the image builds, and before each release toolchain's target builds (fzt-desktop embeds them in its executable); the source's `release.dispatch` to `web-app/dependencies.yml`, or `release/dependencies.yml` for a release, proposes its newest release as a take-up PR |
| `tofu` | `version`, `backend` |
| `docs` | `required` |

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
2. A check runs only when files it reads changed (`input-patterns.mjs`). The tests, and
   whether a merge cuts a release, read every file but documentation (Markdown, `docs/`,
   `LICENSE`, `COPYING`, `NOTICE`), `k8s/` (an image-pin PR changes it, and a pin must never
   cut a release) and `tofu/`; a release (a static app's deploy included) also ignores the
   tests (`*_test.go`, `testdata/`, `tests/`, `test/`, `Tests/`, `benches/`, `*.test.*`,
   `*.spec.*`) and `.gitignore`, which can't change what it ships.
   The other checks, the PR's release packaging among them, read their tool's files. Go
   embeds, Rust includes, Dockerfile `COPY` sources, linked docs, render paths and the files a
   release archives count wherever they are. No repository adds patterns of its own.
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

`cmake` configures a repository's `ci` preset with Ninja and sccache. One with a
`vcpkg.json` gets its dependencies from Visual Studio's vcpkg in manifest mode (the preset
names `$env{VCPKG_ROOT}`'s toolchain file): built packages are kept on the runner, every
download goes through Artifact Keeper (`cmake/vcpkg-fetch.mjs`), and the registry and any
private port come from Forgejo.

## Before a push

`ci-check` (at-home-tools) runs `suites/check.mjs` in a repository's worktree: for the
commits since the default branch, the check jobs its suites' pull-request run would start,
through the same scripts. It reads each suite's `ci.yml` for the jobs, their conditions
and their commands, so a suite change reaches it with no edit there. A test job runs only on
its own platform, and a few jobs run on the pull request only, each with the reason
`check.mjs` gives (`ciOnly`): image builds, release builds and packaging, OpenTofu plans,
and tests that need services on the runner's Docker network.

The repository's own workflows (`.forgejo/workflows`, else `.github/workflows`) count too
(`own-workflows.mjs`, AHT-168): every job a pull request would start there runs through its
own steps and shells, after the jobs it needs, whose outputs decide its condition, or is
named with why the pull request runs it instead. Secrets and variables, a matrix,
containers, system package installs, reusable workflows, actions that aren't a composite
action ci-check holds, and setting up the runner's machine leave a job to the pull request;
pipeline-templates' toolchain setup actions and `actions/setup-*` are skipped, the PC's own
tools standing in as they do for the suites' checks. A job for the other system runs too,
but its failing is reported as the pull request's to decide, and one whose twin for this
system runs the same steps (`suite-tests-linux` and `suite-tests-windows`) is that twin's
run.
