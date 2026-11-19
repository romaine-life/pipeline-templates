# Home CI suites (PIPT-12)

Every home repository's CI comes from here. Our Forgejo build (nelsong6/forgejo, patch
0010) runs, for a repository with `ci-<suite>` topics, the workflows in `suites/<suite>/`
of this repository at `main` (or at the branch its `CI_SUITES_REF` Actions variable names),
always with `default` beside them. A repository keeps no CI files of its own except a
job no suite covers.

## The fleet list

`fleet.json` at this repository's root names every repository on the suites, the suites
it takes, and its setting topics; everything else follows from the repository. It
is the only place a repository's CI is configured: changing the fleet, or any repository in
it, is one PR here. The `Fleet` workflow aligns every owned repository to it: on a PR it
prints what the merge would change, and the merge changes it.

- A listed repository's `ci-` topics become exactly `ci-<suite>` for each suite listed,
  and its setting topics exactly the entry's `topics`.
- Its default branch requires each suite's pull-request statuses, `Suite <suite> / *
  (pull_request)`, `default` included.
- A repository the list doesn't name carries no `ci-` or setting topics.
- Any other topic, one set by hand, is left as it is.

An entry is `{"suites": [...], "topics": [...]}`. `config.mjs` validates it; an unknown field
or topic fails.

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
| `service-postgres`, `service-manticore`, `service-greenmail` | The tests' services, each the image the repository's `ci/services.json` names (below). The tests get `DATABASE_URL`, `MANTICORE_URL`, or GreenMail's `SMTP_HOST`, `IMAP_HOST` and `POP3_HOST` (one address) with `SMTP_PORT`, `IMAP_PORT`, `POP3_PORT` and, over TLS, `SMTPS_PORT`, `IMAPS_PORT`, `POP3S_PORT`, and `GREENMAIL_CERT`: a file holding the certificate GreenMail presents |
| `cluster-image` | A cluster service builds and smoke-tests its own image; without it the service renders and pins what upstream publishes |
| `web-image` | The web app builds its image |
| `web-static` | The web app deploys to its Static Web App |
| `web-history` | The tests compare with the base branch, so the test job gets full history (`origin/<base>`) |
| `release-source` | A documentation repository cuts a source release |
| `release-module` | A Go library: a merge that changes the code takes the next tag and publishes it with its source, building nothing; each fleet repository whose `go.mod` requires it gets a take-up (`go/dependencies.yml`) |
| `release-go`, `release-rust`, `release-npm`, `release-python`, `release-dotnet`, `release-cmake`, `release-powershell` | The toolchains a release builds |
| `rust-build-windows-amd64`, `rust-build-windows-arm64`, `rust-build-linux-amd64`, `rust-build-linux-arm64` | The Rust release targets; with none, Linux x86_64 |
| `version-from-manifest` | The version series comes from the root manifest's version |
| `version-four-part` | Versions take a fourth part, `.0` |
| `home-sync` | A release starts home-sync on every PC |
| `release-external` | The repository's own `.forgejo/workflows/build.yml` builds a release part: the release dispatches it with the tag it reserved, and publishes the files that build uploads (`release/complete-external.mjs`) |

### What the repository's name and files decide

A cluster service or web app is configured by its name and layout, not the list (PIPT-30):

- Its image is `forgejo.romaine.life/<owner>/<repo>` (`cluster-image`, signing in to the
  registry as OpenBao role `<repo>-publish`, reading `secret/services/<repo>-build`) or
  `romainecr.azurecr.io/<repo>` (`web-image`). It builds from `k8s/image/` when its
  `Dockerfile` is there, else from the root.
- Its Static Web App is `<repo>-app` in resource group `<repo>-rg` (`web-static`).
- `k8s/` is what the cluster runs, rendered as a Helm chart (`Chart.yaml`, as release
  `<repo>`, with its `values.yaml` and once more over each `values-<case>.yaml` beside it),
  a kustomization (`kustomization.yaml`), or an Argo CD app of apps (`root-app.yaml`).
- The pin file is the one tracked YAML file that pins the image by digest. Its top-level
  `release` map, if it has one, holds pin fields named for what each takes: `tag`,
  `commit`, `version` (the tag without its v), `date` (when the release was pinned, UTC,
  to the second), or the PR the release's commit merged, `prNumber`, `prTitle`, `prUrl`.
  The pin PR links the work package that PR links.
- Its npm packages are each `package.json` at the root or one directory down with a `test`
  script.

A Rust release builds each target its `rust-build-` topic names, with the values the root
`Cargo.toml` gives it under `[workspace.metadata.pipeline-templates.targets.<target>]` (a single
package's under `[package.metadata...]`): `package` builds that Cargo package alone with its own
default features, for a workspace that ships a different program per platform; `features` and
`noDefaultFeatures` are Cargo's; a Linux target with a `glibc` floor such as `"2.35"` builds
through zig, which another architecture than the runner's x86_64 needs. Windows ARM64 builds
with the Windows runner's LLVM clang.

The services its tests start (PIPT-40) are its `ci/services.json`: each service a `service-`
topic selects, and no other, maps to `{"image": ...}`, the image pinned by digest through
Artifact Keeper; GreenMail's also takes `users`, its accounts, each `login:password@domain`,
signing in with the whole address. A change to it runs the tests (and the image's smoke test)
and cuts no release.

A release publishes what its build leaves at the top of `dist/` under its own names (CMake
installs there, `release/assets/<part>/` adds files beside them), a Rust binary under its
platform (`tuimail-x86_64-pc-windows-msvc.exe` as `tuimail-windows-amd64.exe`) and a folder as
`<folder>-windows.zip` or `<folder>-linux.tar.gz`, with `SHA256SUMS` listing every file. A .NET
release publishes each project that is neither a test project nor referenced by another. A
consumer that wants other names (home-sync) renames on install.

A few other things come from the repository rather than the list (`suites/conventions.mjs`): its
Rust toolchain is its `rust-toolchain.toml` (channel and components), as rustup reads it, else
the pinned stable; its Node major is its `.nvmrc` or `.node-version`, else 24; its Python is
its `.python-version`, else 3.12, and its Python projects are the root's `pyproject.toml`,
else each directory holding one. A release numbers on from the repository's newest `vX.Y.N`
tag (v0.1 with none; a new series starts with its first tag made by hand, such as `v0.2.0`),
or with `version-from-manifest` on the root `Cargo.toml` (or a workspace's one default
member), `CMakeLists.txt` or `package.json`. Some are the same everywhere: OpenTofu 1.11.0,
with each repository's state at `<repo>.tfstate` in the `nelsontofu` account's `tfstate`
container, and `README.md` the one document the docs suite requires. And a Go release builds what its `.goreleaser.yaml` lists, through `goreleaser build` (the
suite keeps versions, upload and home-sync): one Linux job builds the programs, the Windows
runner the `c-shared` DLLs, and each file GoReleaser builds publishes under the name its
`binary` gives it. Every program under `cmd/` must be one of its builds, and a Windows
DLL fails if it imports a MinGW runtime DLL (`lib*.dll`), which nothing ships beside it.

## An image joined to a release

A repository that releases and builds an image (its `cluster-image` or `web-image` topic)
releases them together under one version. A CMake, .NET or Python release builds on Windows
when that toolchain's tests run on Windows alone, else on Linux, and a release syncs the
repository's Forgejo push mirrors, when it has any. Once a release is published, the
repository's own `.forgejo/workflows/released.yml`, when it has one, runs on its default
branch (spirelens' Steam Workshop upload). A cluster image's release publishes the
image and proposes its pin.
The image is built again only when its inputs (its `Dockerfile`, `.dockerignore` and what it
copies in) changed since the release that built the image the pin file runs; otherwise the
release keeps that image, and its pin PR moves only the pin fields, so the pod isn't
restarted. On a PR the image's `--self-test` runs with the assembled release at `/ci/dist`,
in a layer only the check runs, for an image that runs a release binary it doesn't hold.

## What a release downloads

What a release packs beside its build from elsewhere (shows' libmpv) is its repository's
`release/dependencies.json` (`suites/layout.mjs`): a list of `{url, sha256 or lock,
destination}`, each from Artifact Keeper or Forgejo; `extract` takes one file out of a
downloaded archive, a 7z included on a Windows build. The release downloads each once, checks
its SHA-256, and fails on a mismatch.

## npm packages on Forgejo

A repository whose root `package.json` names a package in its owner's scope
(`@romaine-life/<name>`, not `private`) publishes it to Forgejo's npm registry with each
release, at the release's version: the files its `files` lists, from the release's commit,
with the release's assets in `dist/` (`suites/packages.mjs`). Then each fleet repository whose
`package.json` uses it gets a take-up PR (`web-app/dependencies.yml`, or
`release/dependencies.yml` for one without the web-app suite), which takes the newest version
of every package it gets from Forgejo, pinned exactly.

A repository that uses one names the registry and the sign-in in an `.npmrc` beside its
`package.json`:

```ini
@romaine-life:registry=https://forgejo.romaine.life/api/packages/romaine-life/npm/
//forgejo.romaine.life/api/packages/romaine-life/npm/:_authToken=${FORGEJO_PACKAGES_TOKEN}
```

The variable is written without npm 11's `?` default: npm 10, which Node 20's and 22's
images carry, sends `${FORGEJO_PACKAGES_TOKEN?}` literally as the token. Unset, it leaves every
other npm command working.

Nothing stores a credential for them (nelsong6/forgejo README, Package sign-in). In CI
the suite action sets `FORGEJO_PACKAGES_TOKEN` to the job's own short-lived token, so its jobs
that read or publish packages set `enable-openid-connect`; `ci-check` sets it to the token
OpenBao signs for the PC's role `forgejo-packages`. A Docker build gets it as the secret
`FORGEJO_PACKAGES_TOKEN`:

```dockerfile
RUN --mount=type=secret,id=FORGEJO_PACKAGES_TOKEN,env=FORGEJO_PACKAGES_TOKEN npm ci
```

A release that embeds packages in a non-npm build (fzt-desktop's frontend takes
fzt-browser's files) runs `npm ci` in its root before it builds, and the package's own
scripts put the files in place.

## The rules every suite keeps

1. A check runs on the pull request only. A merge builds, publishes and deploys; it checks
   nothing again. A check whose inputs are identical to a passing run's reuses it.
2. A check runs only when files it reads changed (`input-patterns.mjs`). The tests, and
   whether a merge cuts a release, read every file but documentation (Markdown, `docs/`,
   `LICENSE`, `COPYING`, `NOTICE`), `k8s/` (an image-pin PR changes it, and a pin must never
   cut a release) and `tofu/`; a release (a static app's deploy included) also ignores the
   tests (`*_test.go`, `testdata/`, `tests/`, `test/`, `Tests/`, `benches/`, `*.test.*`,
   `*.spec.*`), `.gitignore` and `.forgejo/workflows/`, which can't change what it ships (a
   workflow an external release part builds with counts).
   The other checks, the PR's release packaging among them, read their tool's files. Go
   embeds, Rust includes, Dockerfile `COPY` sources and linked docs count wherever they
   are. No repository adds patterns of its own.
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
