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
| `service-postgres`, `service-manticore`, `service-greenmail` | The tests' services, each the one image every repository's tests use (`suites/conventions.mjs`). GreenMail has two accounts, `alice@example.com` and `bob@example.com`, password `secret`, each signing in with its whole address. The tests get `DATABASE_URL`, `MANTICORE_URL`, or GreenMail's `SMTP_HOST`, `IMAP_HOST` and `POP3_HOST` (one address) with `SMTP_PORT`, `IMAP_PORT`, `POP3_PORT` and, over TLS, `SMTPS_PORT`, `IMAPS_PORT`, `POP3S_PORT`, and `GREENMAIL_CERT`: a file holding the certificate GreenMail presents |
| `cluster-image` | A cluster service builds and smoke-tests its own image; without it the service renders and pins what upstream publishes |
| `web-image` | The web app builds its image |
| `web-static` | The web app deploys to its Static Web App |
| `web-history` | The tests compare with the base branch, so the test job gets full history (`origin/<base>`) |
| `release-source` | A documentation repository cuts a source release |
| `release-module` | A Go library: a merge that changes the code takes the next tag and publishes it with its source, building nothing; each fleet repository whose `go.mod` requires it gets a take-up (`go/dependencies.yml`) |
| `release-go`, `release-rust`, `release-npm`, `release-python`, `release-dotnet`, `release-cmake`, `release-powershell` | The toolchains a release builds |
| `rust-build-windows-amd64`, `rust-build-windows-arm64`, `rust-build-linux-amd64`, `rust-build-linux-arm64`, `rust-build-gba` | The Rust release targets (`gba` is a Game Boy Advance ROM); with none, Linux x86_64 |
| `version-from-manifest` | The version series comes from the root manifest's version; for a release that builds nothing, from its pinned download's ([What a release downloads](#what-a-release-downloads)) |
| `version-four-part` | Versions take a fourth part, `.0` |
| `home-sync` | A release starts home-sync on every PC |
| `release-external` | The repository's own `.forgejo/workflows/build.yml` builds a release part: the release dispatches it with the tag it reserved, and publishes the files that build uploads (`release/complete-external.mjs`). On a pull request that changes what the release reads, it builds the part too, stamped with the tag its merge would take, and keeps the files ([below](#a-release-external-part-on-a-pull-request)), which the merge publishes instead of dispatching it |
| `release-tofu-provider` | The repository, `terraform-provider-<type>`, is an OpenTofu provider: its release publishes it to Artifact Keeper ([OpenTofu providers](#opentofu-providers-on-artifact-keeper)) |

### What the repository's name and files decide

A cluster service or web app is configured by its name and layout, not the list (PIPT-30):

- Its image is `forgejo.romaine.life/<owner>/<repo>` (`cluster-image`, signing in to the
  registry with the publish job's own short-lived token, which nelson's Forgejo integration
  `ci-image-publish` takes, with no stored token, BAO-15) or
  `romainecr.azurecr.io/<repo>` (`web-image`). It builds from `k8s/image/` when its
  `Dockerfile` is there, else from the root.
- Its Static Web App is `<repo>-app` in resource group `<repo>-rg` (`web-static`).
- `k8s/` is what the cluster runs, rendered as a Helm chart (`Chart.yaml`, as release
  `<repo>`, with its `values.yaml` and once more over each `values-<case>.yaml` beside it),
  a kustomization (`kustomization.yaml`), or an Argo CD app of apps (`root-app.yaml`).
- The pin file is the one tracked YAML file that pins the image by digest: as one string,
  `<image>:<tag>@sha256:<digest>`, or, for an upstream chart that names its image by separate
  values, a map whose `registry` and `repository` make the image, with its `tag` and its
  digest as `sha256: <hex>` (OpenProject's chart) or `digest: sha256:<hex>` (Bitnami's); a
  release sets that map's tag and digest. Its top-level
  `release` map, if it has one, holds pin fields named for what each takes: `tag`,
  `commit`, `version` (the tag without its v), `date` (when the release was pinned, UTC,
  to the second), or the PR the release's commit merged, `prNumber`, `prTitle`, `prUrl`.
  The pin PR links the work package that PR links.
- Its npm packages are each `package.json` at the root or one directory down with a `test`
  script. Each package's lint and tests are a check of their own, `check-test (<folder>)`
  (`.` for the root's).

A Rust release builds each target its `rust-build-` topic names, with the values the root
`Cargo.toml` gives it under `[workspace.metadata.pipeline-templates.targets.<target>]` (a single
package's under `[package.metadata...]`): `package` builds that Cargo package alone with its own
default features, for a workspace that ships a different program per platform; `features` and
`noDefaultFeatures` are Cargo's; a Linux target with a `glibc` floor such as `"2.35"` builds
through zig, which another architecture than the runner's x86_64 needs. Windows ARM64 builds
with the Windows runner's LLVM clang.

A Game Boy Advance ROM (`rust-build-gba`, target `thumbv4t-none-eabi`) is an agb crate as agb's
template lays it out: the folder whose `.cargo/config.toml` builds for that target and builds the
standard library there (`[unstable] build-std`), a workspace of its own, since Cargo reads that
file in the folder it runs in and the setting would reach every crate of one workspace
(`rust/gba.mjs`). Cargo builds it in that folder, on the root's toolchain (a nightly with
`rust-src`), and agb-gbafix, at the agb version the crate's `Cargo.lock` holds, makes each
program a ROM titled with its name in capitals (`power-lines` as `POWER LINES`). The rust suite
runs rustfmt in that folder and clippy there for the GBA, as the release builds it; a GBA
program runs only on the console, so it has no host tests.

A release publishes what its build leaves at the top of `dist/` under its own names (CMake
installs there, `release/assets/<part>/` adds files beside them), a Rust binary under its
platform (`tuimail-x86_64-pc-windows-msvc.exe` as `tuimail-windows-amd64.exe`) and a folder as
`<folder>-windows.zip` or `<folder>-linux.tar.gz`, with `SHA256SUMS` listing every file. A GBA
ROM publishes with its part's `release/assets/rust-thumbv4t-none-eabi/` files as one
`<program>.zip`, since the emulator loads them together (power-lines-gba's `power-lines.zip`:
the ROM and its mGBA script); like every ZIP a release publishes, it is signed by at Terminal's
certificate in `<program>.zip.signature.json`, which home-sync checks. A .NET
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
container, `README.md` the one document the docs suite requires, and each test service's
image (Postgres 18.6, Manticore 29.9.0, GreenMail 2.1.3). And a Go release builds what its `.goreleaser.yaml` lists, through `goreleaser build` (the
suite keeps versions, upload and home-sync): one Linux job builds the programs, the Windows
runner the `c-shared` DLLs, and each file GoReleaser builds publishes under the name its
`binary` gives it. Every program under `cmd/` must be one of its builds, every program and
DLL must carry the release's `VERSION`, and a Windows
DLL fails if it imports a MinGW runtime DLL (`lib*.dll`), which nothing ships beside it.

A build carries `VERSION` when its ldflags stamp it, `-X <package>.<variable>={{ .Env.VERSION }}`,
into a variable the program links. The linker ignores an `-X` naming anything else without a
word, so the go suite's tests check each one against the source on every Go pull request, and
the release again before it builds: on each of the build's targets, `go list` says the program
links the package (`main` is the program's own) and `go doc` that the package declares the
variable. Every build that fails is listed at once. Whether a program reads its version is its
own business; the check is about the stamp landing.

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
A joined image is built once, on its PR, as a service's own image is ([An image's PR
build](#an-images-pr-build)): the release's `check-package` builds it with the tag its merge
would take and keeps it, the release's scope attests its fingerprint, and the merge's
`finalize`, building it, pushes the PR's image instead, the same digest. A module's joined
image (fzt-frontend) is checked and kept by the `cluster-service` suite's image check, and its
`module` job publishes it.

## An image's PR build

A cluster service's or web app's own image (`cluster-image` or `web-image`) is built once, on
its PR (`cluster-service/prior-image.mjs`), and so is an image [joined to a
release](#an-image-joined-to-a-release), whose check is the release's `check-package`. The
PR's image check builds it with the tag its merge would take as `APP_VERSION`, runs its
self-test, and keeps it as the run's `check-image` artifact (the image as `docker save` writes it, and its ID), for a
week; the scope attests a fingerprint of what that build reads: the `Dockerfile`,
`.dockerignore` and what the `Dockerfile` copies, where it builds and the image's name, the
version it stamps, and the pipeline-templates files `image.mjs` runs. The merge, once it has
reserved its tag, looks through the merged PR's runs of the suite for one that attested the
same fingerprint and whose check passed, loads that image and pushes it under the tag. The
runners' Docker keeps images in containerd's store, so an image's ID is the digest a push
gives it, and the merge checks the pushed digest is the one the PR built. With no such run (a
direct push, another release took the tag first, the image expired) the merge builds it, as
it would anyway. An image whose `Dockerfile` declares `ARG SOURCE_SHA` stamps the commit,
which only the merge makes, so it is built on the merge (landing-page, tuimail).

## A release-external part on a pull request

A merge publishes what its pull request built of a `release-external` part, as it does the
suite's own builds (rule 1, PIPT-55). On a pull request that changes what the release reads
(`node _ci/suites/inputs.mjs release`, its `build` output), the repository's `build.yml`
builds the part as the release would:

- It stamps the tag the merge would take: `./_ci/actions/release-version` with
  `publish: 'false'` and the scope's `prefix`, `prefix-from` and `suffix`, its `next` output in
  place of the reserved `release_tag` (at-terminal's MSIX is `at-terminal_1.25.N.0_x64.msix`
  on the pull request too).
- It ends in the step a release ends in, `node _ci/suites/release/complete-external.mjs`,
  with `VERSION` that tag. On a pull request that step packages `dist/` as a release would
  (a folder as `<folder>-windows.zip`) and writes the part's fingerprint to its log: the
  files the release reads (`build.yml` among them), the tag, the repository's settings, and
  the pipeline-templates files the workflow runs (each action it uses from `_ci` and each
  script a step runs from `_ci/suites`, with what they reach).
- It keeps `dist/` as the run's artifact, named by that step's `artifact` output
  (`check-release-build`), with `forgejo/upload-artifact`.

The merge's `reserve` job, once it holds the tag, looks for the newest of the merged pull
request's `build.yml` runs in which a job that succeeded attested that fingerprint and that
still holds the files; when it finds one, the release dispatches nothing and `finalize`
publishes those files, with the log saying whose they are. Any other merge dispatches
`build.yml` as before, as does one whose lookup fails.

## What a release downloads

What a release packs beside its build from elsewhere (shows' libmpv) is its repository's
`release/dependencies.json` (`suites/layout.mjs`): a list of `{url, sha256 or lock,
destination}`, each from Artifact Keeper or Forgejo; `extract` takes one file out of a
downloaded archive, a 7z included (Windows' tar reads it, 7-Zip on Linux), and a `*` in its
path stands for any one name there, such as an archive's one top folder named for its build.
A lock file is exactly `<tag> <sha256>`, its tag filling the url's `{tag}`. The release
downloads each once, checks its SHA-256, and fails on a mismatch.

A release that builds nothing (no release toolchain and no `release-external`) is its
downloads: they and its `release/assets/files/` are its one part, on Linux, signed and
published like a build's.

A source that keeps only its newest file under one name (mGBA's development build, which S3
serves only as `mGBA-build-latest-win64.7z`) can't be pinned at its address, which moves. Its
entry names that address as `latest`, with a `lock` and no `url`: the release reads the copy
the lock pins from Artifact Keeper's hosted `snapshots` repository, at
`<owner>/<repo>/<tag>/<file>`. `version`, a pattern with groups on one entry of that lock,
names the copy: the groups joined by dots, as they read everywhere in the file that entry
takes (`(\d+\.\d+)-(\d+)-[0-9a-f]{7,}` reads mGBA.exe's `0.11-9187-e6c1715` as
`0.11.9187`), and the release checks its file still reads so; without one, the copy is named by
the start of its SHA-256. With `version-from-manifest`, a release that builds nothing numbers
on that version, `v0.11.9187.N`.

A pin moves through the dependency take-up, `Suite release dependencies`, run from the
Actions tab, and on a push that changes `release/dependencies.json`, which pins a `latest` entry
it adds (`release/snapshots.mjs`): it downloads each `latest` file, and when it differs
from the pin, copies it to its snapshot address (never replacing a copy already there) and
proposes the lock that pins it as a take-up PR, whose merge releases it. Its job publishes with
its own token, so the repository needs its line in nelsong6/artifact-keeper's
`k8s/publishers.txt`: `snapshots <owner>/<repo> <Forgejo id>`.

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

## OpenTofu providers on Artifact Keeper

A repository named `terraform-provider-<type>` with the `release-tofu-provider` topic is an
OpenTofu provider, installed from the source address `artifacts.home.romaine.life/<owner>/<type>`
(`romaine-life/terraform-provider-openproject` is `artifacts.home.romaine.life/romaine-life/openproject`).
Its release toolchain builds the provider as programs named
`terraform-provider-<type>-<os>-<arch>`, `.exe` on Windows (a Go provider's `.goreleaser.yaml`
build sets `binary: terraform-provider-<type>-{{ .Os }}-{{ .Arch }}`), for `linux_amd64` and
`windows_amd64` at least. The build publishes each as the package tofu installs,
`terraform-provider-<type>_<version>_<os>_<arch>.zip` holding
`terraform-provider-<type>_v<version>`, and a release missing either platform fails. Versions are
the release's, `X.Y.Z`, so the topic takes no `version-four-part` (`release/tofu-provider.mjs`).

Once the release is published, its packages go to Artifact Keeper's hosted repository
`tofu-providers`. Nothing stores a credential: the job asks Forgejo for its own token with the
audience `https://artifacts.home.romaine.life` and trades it at Artifact Keeper for an hour's
token that may write there and nowhere else. Artifact Keeper takes it only from a repository its
`k8s/publishers.txt` lists (nelsong6/artifact-keeper), on a push or dispatch of `main`, so a new
provider repository adds its line there. A version is published once; a rerun finds its own
packages there, and a package that differs is refused.

The suites' jobs install them through `home-cache`, which adds the mirror
`https://artifacts.home.romaine.life/terraform/tofu-providers/` for
`artifacts.home.romaine.life/*/*`; home-sync writes the same mirror into each home PC's
`%APPDATA%\tofu.rc`, with every other provider installing directly as before.

A repository that uses one requires it by that address:

```hcl
terraform {
  required_providers {
    openproject = { source = "artifacts.home.romaine.life/romaine-life/openproject", version = "0.1.2" }
  }
}
```

and commits its lock with the hashes for Linux, where CI runs it (`tofu init -lockfile=readonly`),
and Windows, where the home PCs do. `tofu providers lock` asks each provider's registry, and
`artifacts.home.romaine.life` isn't one, so our providers are locked from the mirror, each named,
and the registry's as usual; each run updates only the providers it names:

```sh
tofu providers lock -net-mirror=https://artifacts.home.romaine.life/terraform/tofu-providers/ \
  -platform=linux_amd64 -platform=windows_amd64 artifacts.home.romaine.life/romaine-life/openproject
tofu providers lock -platform=linux_amd64 -platform=windows_amd64 hashicorp/random
```

A new version is a change to `version` and the lock, made the same way.

## The rules every suite keeps

1. A check runs on the pull request only. A merge builds, publishes and deploys; it checks
   nothing again. A check whose inputs are identical to a passing run's reuses it. A PR's
   release build stamps the tag its merge would take, and the merge that reserves that tag
   with the same inputs (every file a release reads, the pipeline-templates files the build
   runs, the settings and the parts) publishes the PR's files rather than compiling them again
   (`release/prior-build.mjs`); kept a week, they're built again after that. A
   `release-external` part's PR build does the same, and its merge dispatches no `build.yml`
   ([A release-external part on a pull request](#a-release-external-part-on-a-pull-request)).
   A cluster or web app's image check does the same, a release's joined image included: the
   merge pushes the PR's image, the same digest, under its tag ([An image's PR
   build](#an-images-pr-build)).
2. A check runs only when files it reads changed (`input-patterns.mjs`). The tests, and
   whether a merge cuts a release, read every file but documentation (Markdown, `docs/`,
   `LICENSE`, `COPYING`, `NOTICE`), `k8s/` (an image-pin PR changes it, and a pin must never
   cut a release) and `tofu/`; a release (a static app's deploy included) also ignores the
   tests (`*_test.go`, `testdata/`, `tests/`, `test/`, `Tests/`, `benches/`, `*.test.*`,
   `*.spec.*`), `.gitignore` and `.forgejo/workflows/`, which can't change what it ships (a
   workflow an external release part builds with counts).
   A web app's npm package in a folder of its own is tested when that folder changed, or the
   root's `.nvmrc` or `.node-version`, or what the package references outside it: a relative
   module its sources import (`import`, `export ... from`, `import()`, `require()`, `new
   URL(..., import.meta.url)`), a path they join onto their own folder (`__dirname`,
   `import.meta.dirname`, or a name given `dirname(fileURLToPath(import.meta.url))`), a `../`
   path in a script `npm run lint` or `npm test` runs, a `file:` dependency or its tsconfig's
   `extends` (`dependencies.mjs`); crenellation's frontend reads `romlab/names.curated.json`,
   and its backend's tests build the frontend.
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
7. A Go repository (a root `go.mod`) builds its Go only through the suites: it takes the `go`
   suite, none of its own workflows runs `go build` or `go install` of its own packages, and on
   the release suite each program (under `cmd/`, or a root `package main`) ships through
   `release-go`, so every one carries its version. A Forgejo copy of a repository developed on
   GitHub, which its `.github/workflows/forgejo-sync.yml` fast-forwards, is built there.

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
