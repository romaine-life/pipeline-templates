# Home CI suites — PIPT-12

Every repository receives `default` automatically. Topics select only additional
suites, such as `ci-go` and `ci-release`; no `ci-default` topic is required.
`CI_SUITES_REF` selects this repository's workflow **and script** revision together.
This PR stays held for repos-56's review. No consumer is changed here.

## Legacy callers remain supported until the final cleanup

The two Forgejo reusable templates remain byte-identical to `origin/main` at
`94a7450aff1e9c20d507d9256b16cf3075eaff78`. Suites replace their use as repositories
migrate; deleting the templates belongs in a **final pipeline-templates PR after
all callers have migrated**, rather than this suite-introduction PR.

| Retained workflow at `@main` | Unmigrated callers | Inputs supplied |
|---|---|---|
| `.forgejo/workflows/go-dependency-update-template.yml` | `romaine-life/at-home-tools`, `fzt-automate`, `fzt-browser`, `fzt-frontend`, `fzt-picker`, `fzt-terminal`: each `.forgejo/workflows/dispatch.yml` | All supply `modules`; fzt-picker also supplies `go-mod-path` |
| `.forgejo/workflows/release-and-dispatch-template.yml` | `romaine-life/fzt-picker`, `romaine-life/fzt-terminal`: each `.forgejo/workflows/release.yml` | `artifact-build-workflow`, `draft-release` |

The compatibility audit enumerated all 86 repositories in the romaine-life and
nelsong6 owners, including archived and empty repositories, at their origin default
branch commits. It read 324 workflows, action definitions and linked helpers;
336 literal `@main` uses matched the structured audit, with no unmatched or dynamic
pipeline references and no checkout-based or raw-download readers. Immutable source
commits, file paths, every caller and its supplied input/consumed output names are
recorded in [compatibility-audit.json](tests/compatibility-audit.json).

The other referenced reusable APIs are unchanged: Forgejo `home-sync.yml` (25
callers), GitHub `release-and-dispatch-template.yml` (pipeline-templates' GitHub
dependency template), and GitHub `tofu-plan-apply-template.yml` (tank-operator's
`.github/workflows/tofu.yml`). The GitHub workflows and home-sync remain untouched.

All 15 existing action APIs preserve their input names, types, required/default
values, output names and output mappings: azure-cli, cached-images, check-fetches,
check-image-digests, check-versions, home-cache, prune-releases, release-version,
rust-toolchain, setup-dotnet, setup-go, setup-node, setup-opentofu, setup-python and
setup-uv. Their Windows shell changes only make NoProfile/NonInteractive explicit;
installer and release implementation bodies remain unchanged. Check-fetches' helper
intentionally checks only Forgejo workflows and ignores injected `_ci` files, as
required for suite cleanup; all 70 audited calls to it are Forgejo workflows, with
no GitHub workflow caller relying on the old fallback.

No external workflow/action/helper reads the deleted `reference/` files. The old
self-CI lint glob is replaced here; the only other literal `reference/` substring
is street-fighter-reference's own repository name in a GitHub Pages API request.
The copied reference shapes can therefore be removed in this PR. CI guards the
two legacy workflow blobs and every audited interface, and runs those guards when
an interface definition or the audit changes; it does not re-query the estate on
each PR. Additive optional inputs/outputs remain possible, while removal, changed
defaults or new required inputs fail the compatibility check.

## Publishing credentials and live API proof

Image pin and Go dependency PRs use Forgejo's own auto-merge, authorized with
`PIPELINE_DISPATCH_TOKEN` (`PIN_TOKEN` for pins, `TOKEN` for dependency take-ups).
They POST `/pulls/{number}/merge` with `Do: squash`,
`merge_when_checks_succeed: true`, `delete_branch_after_merge: true` and
`head_commit_id` set to the pushed commit. Existing matching dependency PRs are
re-armed on retry; a changed head is never accepted as the requested commit.
There are no queue labels or issue API calls, and the token's scopes stay unchanged.
No job waits for the PR to merge. Retrying a publish reuses the tag reserved on
that source commit instead of allocating another patch version.

| API consumer | Credential | Permission proof |
|---|---|---|
| Pin and Go dependency PRs: pulls, contents, auto-merge, branch deletion | PIPELINE_DISPATCH_TOKEN | `Publishing token proof` creates a real fixture PR, arms and re-arms auto-merge on its exact head, cancels it, closes it and deletes its branch. The private fixture returns 404 to the Actions token's cross-repository auto-merge request. |
| `release.mjs` mirror list/sync and downstream dispatch; Forgejo external build/callback dispatch | PIPELINE_DISPATCH_TOKEN | The same job lists/syncs the fixture's empty mirror set and dispatches its own workflow with a skipped job, without waiting. A remote mirror transfer and external worker completion remain pilot assertions. |
| Release version, release staging/protocol, receipts/statuses, pruning and published asset download | Actions GITHUB_TOKEN | `Draft release proof` reserves a tag twice, recovers/stages a real draft, replaces assets, verifies receipts, publishes a temporary prerelease, downloads its payload and removes its own release/tag. It exercises release listing and asset deletion without pruning unrelated releases. |
| Cross-repository Forgejo release dependency downloads | PIPELINE_DISPATCH_TOKEN as DEPENDENCY_TOKEN | Checksum-pinned downloads use this credential explicitly; they never fall back to the job token. |
| Outward GitHub build dispatch | GITHUB_DISPATCH_TOKEN | Separate provider credential; macOS callback execution remains a pilot assertion. |
| OpenBao login/read/revoke and registry push | Actions OIDC JWT, then leased Bao/registry credentials | Consumer role/secret permissions are exercised by its image pilot. |
| Azure login, ACR and Container Apps/Static Web Apps | Azure OIDC identity, registry/SWA credentials obtained by Azure CLI | Consumer Azure grants are exercised by its web-app pilot. |

[romaine-life/pipeline-token-proof](https://forgejo.romaine.life/romaine-life/pipeline-token-proof)
is a private CI permissions fixture with Actions disabled. Its main branch requires
`ci-token-proof/blocked`, including for administrators; the test posts that status
as permanently pending before arming auto-merge, so no test PR can land. Successful
cancellation proves a scheduled merge existed, and CI asserts main did not move.
Cleanup cancels any remaining schedule, closes the test PR and removes its branch.
Fixture provisioning is separate from the production credential's permissions.

## Execution contract

Checks run only on opened, reopened and synchronized PRs. Each check names its
positive input set in `input-patterns.mjs`; job-level conditions preserve skipped statuses.
Pushes and dispatches build, publish and deploy without repeating checks. Tofu apply
uses the push's exact `before..sha` inputs, applying on missing/all-zero `before`
or an explicit default-branch dispatch; a missing nonzero commit fails, not apply-all.
No schedules, trigger paths or polling jobs are introduced.

Only scope jobs fetch history. Other check/build jobs use
checkout's normal shallow depth. Every workflow cancels superseded PR runs and keeps
default-branch runs. Builders and tests cap compiler/process parallelism at four.

| Suite | Standard commands/layout | Runner |
|---|---|---|
| default | home check-fetches; own-workflow rules | Linux |
| go | root go.mod; gofmt; `go vet -p 4 ./...`; `go test -p 4 ./...` | Linux; Windows tests only when requested |
| rust | root workspace/lock; fmt once; clippy/tests; optional typos/machete | requested test platforms; format/lints Linux |
| cmake | root `CMakePresets.json`, configure preset `ci`, Ninja, Release; build; ctest | requested native platforms |
| dotnet | root solution or project; locked restore; format; Release tests | requested native platforms |
| python | pyproject.toml and uv.lock; frozen uv sync; ruff check/format; pytest | Linux unless explicitly requested otherwise |
| release | one joined draft for every declared builder and external part | Go cross/npm/Python/signing on Linux; native Go C-shared, MSVC Rust and native SDK work on Windows |
| cluster-service | explicit renders; strict schemas and digests; image self-test; OpenBao publish and auto-merge pin | Linux |
| web-app | locked npm packages; lint/test; optional ACR image/self-test and deployment | Linux |
| tofu | committed provider sources/lock; fmt, validate, plan on PR; apply on relevant push | Linux |
| docs | UTF-8 Markdown, guides, real local links, diff whitespace; optional source release | Linux |
| powershell | pwsh 7 parsing; JSON parsing; optional Windows PowerShell 5.1 | pwsh 7 on Linux, 5.1 on Windows |

The `windows-release` name is replaced by `release`: the workflow joins toolchains
and platforms and does not consume a Windows slot for a cross-compiled Go program.
The added CMake, .NET and uv/Python suites remove toolchain copies from consumers.
Source-specific assertions belong in ordinary project tests (Go tests, Cargo tests,
ctest, .NET tests or pytest), not in copied workflow commands.

Scripts run from a consumer worktree root. A local `ci-check` can install the locked
Node dependencies and run these same scripts; compiler setup actions are CI wrappers.
For example, `node <templates>/suites/go/test.mjs` needs Go on PATH and no runner-only
paths. Local scope diffs require the exact PR base SHA in `BASE`. Artifact
publication additionally requires a push/dispatch of the actual default branch.

## Kept work and input ownership

Go's build/module caches persist. Private romaine-life Go dependencies are rewritten
to Forgejo with a process-local Git credential header, never a token argument.
Cargo targets persist per repo, compiler and job; old compiler folders are removed
only when unused (Windows rename; Linux nonblocking shared/exclusive flock leases).
CMake keeps configure/build state and uses checksum-pinned Ninja and sccache; .NET
keeps NuGet packages and per-project intermediates under its exact SDK; uv keeps its
package/build cache and project environment. No dependency installer runs apt.

CMake, Helm, kustomize, kubeconform, actionlint, pwsh, Ninja, sccache and osslsigncode are
kept and checksum-pinned in `tools.mjs`. osslsigncode is Ubuntu noble's `2.8-2`
package, SHA-256 from its Packages metadata, extracted once rather than apt-installed
per run. Its libssl/libcurl runtime is supplied by the Ubuntu job image. Windows
signing is not required for ordinary Go/Rust binaries. The Windows Authenticode
script remains an integration fixture, not the release's signing path.

`CI_CACHE_ROOT` overrides the kept root. Defaults are `D:/ci/cache` on Windows CI,
`RUNNER_TOOL_CACHE/ci-suites` on Linux CI, and the user's cache locally. CMake's
native compiler/SDK and .NET SDK must be installed by the standard runner image/setup;
a repo never installs host packages in its own workflow.

Go embeds, Rust literal includes, Markdown local targets and named Docker COPY
sources extend the declared input sets. Dockerfiles name their COPY sources; whole
context/variable/remote COPY inputs fail rather than guessing. Runtime fixtures,
nonliteral includes and custom build-script inputs are explicit `inputs` additions.
Deleted inputs participate. Only the `.ci.json` fields a check reads participate in that check's fingerprint.

## Reusing a passing check

Scope hashes each check's positive pattern set, matching Git tree entries (including
removals and executable bits), embedded/linked inputs, relevant configuration fields,
and the exact suites commit. Linux, Windows, services and PowerShell 5.1 variants
have independent records. Downstream jobs pin their script checkout to that commit.
Configuration fields are selected semantically; the JSON syntax check hashes each
whole JSON file it parses, including `.ci.json`.
A source change, relevant setting/pattern change or suites revision produces a new
fingerprint; a README-only push, unrelated main merge or requested rerun reuses an
identical passing fingerprint. Markdown whitespace is checked against the complete
current Markdown tree, so its result does not depend on a previous commit.

After native check results settle, `reused-checks` saves a tiny run pointer in the
runner's repository/fingerprint Actions cache. Restoring a pointer never establishes
a pass: scope verifies the exact injected workflow/job, its native Actions success
and the matching fingerprint in the immutable scope job's historical server log.
Repository files, author-created statuses and cache payloads cannot assert a pass.
The same native history remains valid when a rerun resets the latest job result.
The recorder posts skipped statuses naming the commit where identical inputs passed.
Missing/evicted cache or log data requires one executed baseline; retention reduces
reuse rather than checking. The cache uses the runner's legacy Actions cache protocol
with a separate version for small JSON records and a new pointer per successful run; it never extracts an archive or needs
a runner filesystem path.

The joined release's matrix builders and signed assembly form one packaging check:
only a complete `check-package` pass records it. Reusing that pass skips the builder
matrix and assembly together; partial builds never stand in for verified packaging.
Production scope uses fingerprints on PRs; local scope remains an offline changed-file
selector. `.forgejo/workflows/fingerprint-proof.yml` exercises the real cache and
status API using a JSON check and an independently selected immutable suites ref.
Its fixtures separate documentation pushes, JSON input changes and suites-ref changes.

## `.ci.json`, version 1

One small root JSON file supplies data, never shell command strings. Unknown section
fields fail. Paths use `/`, are repo-relative, and cannot escape through drives or
`..`. Optional sections are independent. A typical joined release is:

```json
{
  "version": 1,
  "go": { "platforms": ["ubuntu-latest", "windows-latest"] },
  "rust": { "platforms": ["windows-latest"], "noDefaultFeatures": true },
  "web": { "packages": ["frontend"], "node": "24" },
  "release": {
    "toolchains": ["go", "rust", "npm"],
    "prefix": "v0.1",
    "homeSync": true,
    "goTargets": [
      { "goos": "windows", "goarch": "amd64", "packages": ["./cmd/..."] },
      { "goos": "linux", "goarch": "amd64", "packages": ["./cmd/homesvc"] },
      { "goos": "linux", "goarch": "arm64", "packages": ["./cmd/router-agent"] },
      { "goos": "darwin", "goarch": "amd64", "packages": ["./cmd/agent-guidance"] },
      { "goos": "darwin", "goarch": "arm64", "packages": ["./cmd/agent-guidance"] }
    ],
    "windowsGui": ["./cmd/home-sync", "./cmd/claude-transcripts"],
    "goStampPackages": ["main"],
    "rustTargets": [
      { "target": "x86_64-unknown-linux-gnu", "features": ["streaming", "rustls-tls"] },
      { "target": "x86_64-pc-windows-msvc", "features": ["streaming", "media-control"] }
    ],
    "external": [
      { "id": "macos", "provider": "github", "repository": "romaine-life/tuimail", "workflow": "macos.yml", "assets": ["tuimail-macos.tar.gz"] }
    ]
  }
}
```

`goTargets` supplies GOOS/GOARCH pairs and optional package selections (including
pinned private module packages). An omitted selection builds `./cmd/...`.
Assets are `<command>-<goos>-<goarch>[.exe]`. Only named `windowsGui` packages receive
`-H windowsgui`, only for Windows. Stamp packages expose version/buildRepo/buildServer/
buildTime; defaults use main. A `cmd/<name>/<name>.manifest` is embedded through kept
rsrc 0.10.2 before linking, so at-home-tools needs no Windows manifest job.

Rust targets carry their exact features and optional noDefaultFeatures override;
only `*-windows-msvc` targets request Windows. Apple Rust targets use a GitHub part.
Rust check features default to `rust.features`, with optional `rust.platformFeatures`
keyed by `linux`/`win32`. Optional `rust.lints` selects `typos` and/or `machete`;
those tools are pinned and kept, not installed on every run.

Other builder names are `python`, `dotnet`, `cmake` and `powershell`. Python produces
wheel/sdist assets from `python.projects` (default root); `.NET` publishes the entry
projects in `release.dotnetProjects`; CMake uses install rules; PowerShell packages
`commands/` and derives `commands.json`. Directory assets become Linux tar.gz or Windows ZIP packages; a named directory map can select either format explicitly.
Npm runs `npm run build`, packages each project's dist directory, and never runs
lint/test on the release path. Native SDK builds can select `cmake.buildPlatform`,
`dotnet.buildPlatform` or `python.buildPlatform`; otherwise they use Linux.

`release.dependencies` replaces cross-repo fetch jobs. Each item has `url`,
`destination`, optional `toolchain`/`targets`, and either `sha256` or `lock`. Target names are Rust triples, Go OS-architecture pairs, or a native Go OS-architecture-c-shared part. A dependency under dist/ without targets belongs to the first part of its toolchain; vendor inputs outside dist/ are available to every matching build. Multiple publishing targets must consume the dependency in distinct archives or assign distinct published names; ownership is validated before downloading. A lock contains
exactly `tag sha256`, with `{tag}` in the URL. Downloads come only from Forgejo or
Artifact Keeper, are checksum-verified and cached by content. Forgejo reads use
`DEPENDENCY_TOKEN`, supplied by PIPELINE_DISPATCH_TOKEN. Build.rs/project build
configuration consumes the declared vendor path, rather than a CI-specific path.

`release.archives` entries `{name,sources,toolchain?,targets?,entries?}` make ZIP or tar.gz packages from named files/directories. entries maps a source basename to its required name inside the archive. Sources under dist/ are consumed after all recipes, preventing duplicate loose assets in assembly. Archives and names accept {tag} and {version} (the tag without its leading v). Authenticode covers executable/DLL/MSI/CAB files, including inside generated
packages. ZIPs additionally use the existing repository/tag/digest RSA signature JSON
format, so command bundles and the GBA package share signing. Signing uses
AT_TERMINAL_PFX and its password via files/environment, never a command argument.

`release.assets` can require explicit dist files in the assembled result. `prefix`
or `prefixFrom` and optional `suffix` feed release-version. `dispatch` names downstream
owned repositories/workflows; `mirror:true` requests the existing Forgejo push mirror
without waiting for it. All builders use one version and one draft.

`release.image` is `cluster` or `web` when a repo joins host binaries and an image.
The image consumes the assembled dist files; the separate image publisher is disabled.
PR packaging smoke-tests the real image with its configured services. Default builds
publish the image and place its pin in the same draft. Deployment/pin submission runs
only after all parts are complete and that release is published. Thus spotify-player
and auth need no separate release coordinator or second release for one commit.


### Target selection and published names

`release.assetNames` maps a part ID (go, rust-<triple>, cmake, dotnet, npm or an
external ID) to source-relative dist names and their published basenames. Go can
instead select go-<os>-<arch> or go-<os>-<arch>-c-shared. One * captures a name;
{tag}/{version} expand the reserved version. A source may be a directory whose
published name selects .zip or .tar.gz, or a nested file extracted as a loose asset.
A nested file and its containing directory can both be published intentionally.
Ambiguous matches and output collisions fail. Each builder starts with a clean dist/
while compiler/module caches stay kept. Repository-owned static payloads belong in
release/assets/<part>/ and are copied once by that builder.

Go C-shared targets declare buildmode:c-shared and packages; only Windows/amd64
C-shared work uses Windows, while ordinary Go releases cross-compile on Linux.
Go js/wasm is a standard target. Rust builds workspace binaries and cdylibs; optional
release.sourceLists maps a Rust part to a source-list filename derived from Cargo's
actual depfiles and tracked repository inputs. release.manifest selects the existing
{tag,commit,files:{name:{size,sha256}}} format; checksumFiles selects per-asset .sha256
sidecars, and checksumManifest selects a joined SHA256SUMS-style file. These metadata
names are validated and generated after signing and all asynchronous uploads.

Windows run steps, including the local composite actions, explicitly use -NoProfile
and -NonInteractive. Fingerprint producers read the fixed check job names and
workflow names directly from YAML: platform tests are `check-test-linux` and
`check-test-windows`. The existing services variant remains `check-services`.
There is no platform matrix, per-row naming convention or matrix context in a
platform job condition.

### Fixed platform checks and the release matrix audit

Go, Rust, CMake, .NET and Python each declare two fixed jobs. Scope emits independent
`test-linux` and `test-windows` booleans, true only when that platform is declared
and its fingerprint needs a check. Both fixed jobs always exist; an undeclared or
reused platform skips at job level, and `reused-checks` depends on both terminal
jobs before recording passes and posting reused statuses. For Go/Rust services,
the plain Linux job skips while the separate services job uses its own fingerprint.
A fully reused check cannot erase a dependency from the run.

This repository's own suite tests also use fixed Linux and Windows jobs. The NAS
setup job has fixed labels rather than a one-element platform matrix. The parallel
service-slot matrix remains because it proves independent simultaneous container
lifecycles, rather than selecting platforms.

Release build and check-build matrices still depend only on declared builders,
never on reuse. External-only releases retain skipped rows for their declared
external parts, with `has-local: false` skipping local builds. An explicitly empty
Rust target list is rejected. Existing `always()` collectors handle skipped builds
and callback reserve/build jobs; the separate dispatch after home-sync intentionally
skips when publish already dispatched downstream workflows itself.

The real fingerprint proof uses these same fixed job names, scope planner and
shared Rust test script with a tiny native Linux/Windows workspace. It asserts each
native job's result and the reused status's passing commit, and includes an
external-only release build behind a skipped reserve dependency. After the initial
fresh passes, changing only the Windows feature selection in
`suites/platform-proof.json` exercises one reused and one running job; keeping both
feature selections fixed then exercises both jobs skipped and both passes reused.
There is no expected-case staging flag, job environment workaround, relaxed
matrix-context lint rule, or Forgejo/runner prerequisite.

The [fresh proof](https://forgejo.romaine.life/romaine-life/pipeline-templates/actions/runs/276)
ran both fixed jobs at `97d0ad6`; the
[mixed proof](https://forgejo.romaine.life/romaine-life/pipeline-templates/actions/runs/281)
at `c144a00` reused Linux from that commit and ran Windows with its changed feature
selection. Both collectors completed, including the skipped external-only build
dependency. The following documentation-only push keeps both check inputs fixed
to exercise two skipped platform jobs and publication of both reused statuses.

### Release fields in pin files

`cluster.pinFields` and `web.pinFields` map dotted paths to existing scalar fields
in the YAML `pinFile`. Each source is `tag` (the reserved tag, including `v`),
`version` (the tag without an initial `v`) or `commit` (SOURCE_SHA, falling back to
GITHUB_SHA). Missing fields, unknown sources and missing release identity fail;
fields are never silently created. The image and these fields are committed in
one pin PR, including when the image stays the same but the release metadata moves.
YAML comments and scalar quoting are preserved.

The origin/default-branch audit of all 76 repositories in the release compatibility
inventory is recorded in `tests/pin-audit.json`. These are the pin files carrying
application release fields beside the image:

| Repository | Pin file | `.ci.json` fields to add |
|---|---|---|
| nelsong6/spotify-player | `k8s/values.yaml` | `"cluster": {"pinFields": {"release.tag": "tag", "release.commit": "commit"}}` |
| romaine-life/chess-tactics | `k8s/values.yaml` | `"web": {"pinFields": {"build.commit": "commit"}}` |
| romaine-life/kill-me | `k8s/values.yaml` | `"web": {"pinFields": {"release.version": "version"}}` |

These fragments extend each repo's existing section, including `pinFile`, rather
than replacing it. Chess-tactics and kill-me must normalize their split
image.repository/image.tag into the shared full digest-pinned image convention
when adopting the suite. Chess-tactics' existing build.prTitle/prNumber/prUrl are
PR description metadata rather than tag/commit/version; remove their old static
values in its migration so they cannot claim an earlier PR. Helm Chart.yaml and
vendored dependency versions are not application release fields in the pin file.
Kill-me also carries release.deployedAt, a deployment timestamp rather than a
tag/commit/version selector; remove its old static value during migration instead
of preserving a stale deployment time in the new pin PRs.
The Spotify regression test updates its actual origin values file and proves the
stager tag/commit move together with the image.

## Durable release and completion hook

Reservation stores the plan and receipts in a versioned block in the release body,
read and written through the release API with the job token. The attachment GET API
returns metadata; the draft web download route does not grant Actions tokens draft
write access. A receipt binds each uploaded byte hash to its acknowledged immutable
attachment ID, UUID, name and size. Finalization verifies those identities through
the API, detects replaced/renamed/unexpected assets, and never downloads draft bytes.
Published materialization additionally checks the downloaded bytes against the receipt.

The verified v0.1.93 recovery shape (same source SHA/header, draft, only the old plan
attachment) upgrades in place when reserve is retried. It retains its tag and release
ID and removes that obsolete attachment. Interrupted cleanup is retried safely.
The held PR's real Actions-token draft test exercises this recovery, a repeated
reserve/finalize, replacement detection and generated metadata, then deletes its draft/tag.
Missing parts post pending and exit; failures post failure. Only a complete draft
loses its prerelease flag, so unchanged home-sync cannot publish a partial release.

External workers upload only their declared assets and send the receipt in the
callback's receipt input. The Forgejo workflow's default-branch concurrency serializes
local and callback receipt writes; external workers never race release-body updates.
Checksum lists and the optional tag/commit/files manifest are generated only after
all receipts arrive, so asynchronous macOS assets participate without a waiting job.
Published releases remain immutable.

GitHub dispatch inputs are `release_tag`, `source_sha`, `release_repository`,
`part_id`, `callback_workflow` and `suites_ref`. The worker checks out exactly source_sha,
builds only (no repeated checks), and calls `release/complete-external.mjs` with
VERSION, SOURCE_SHA, PART_ID, RELEASE_SERVER_URL, RELEASE_REPOSITORY and a Forgejo
write token in TOKEN. Success stages the declared dist assets, then
sends a dispatch with release-tag/source-sha/completed-part/completion/receipt to
`release/ci.yml`. Failure sends completion=failure. No job watches a GitHub run.
GITHUB_DISPATCH_TOKEN authorizes the outward GitHub dispatch; PIPELINE_DISPATCH_TOKEN
is the Forgejo callback token. Source identity is checked against the durable plan.

The same receipt contract accepts `provider:"forgejo"` for the **listed** unique
builders below. Such workers own only their unique compile/packaging operation,
not numbering, joining, common signing implementations, publishing, pruning or delivery. Workers call the shared signer (or their unique native SDK signer) before completion; ZIP signature sidecars are reserved automatically. A pure external
release may have no local builders. This is not permission to retain copied Go/Rust/
CMake/.NET/Python checks or an old mixed-release workflow.

## Services on the current runner

The runner keeps `container.network: host`. A Linux service job calls
`services.mjs start` through its existing Docker daemon, creates a UUID-named bridge
and containers, and publishes no host ports. Tests receive each container's bridge
IPv4 address; the host-networked job can reach those addresses on this DinD daemon.
Image smoke containers join the same bridge. Each container has a Docker health
check: pg_isready over TCP for Postgres, SHOW TABLES over HTTP for Manticore, and
both SMTP/IMAP greetings for GreenMail. Images must supply pg_isready, wget/grep,
or bash with /dev/tcp respectively; the pinned CI fixtures exercise those commands.

Before any container starts, the job subscribes to Docker's events API with its
ownership label and health_status/die filters. Subscription completes at the HTTP
headers, so startup events cannot be missed. It waits for every healthy event,
fails on unhealthy/exit/stream failure, and uses one overall readiness deadline.
No timer re-probes readiness in our code. A final one-shot TCP assertion verifies
bridge reachability after Docker reports healthy. No release, external build or
deployment is polled.

`services.mjs stop` runs in an `if: always()` step, including after cancellation with
the patched runner. Ownership is written before any Docker resource is created;
cleanup finds only that UUID's labelled resources, removes containers and anonymous
volumes before networks, verifies absence, and retains state if cleanup needs a retry.
The state path defaults to `.ci-services.json` in the worktree, with
`CI_SERVICE_STATE` available for local callers. Locally run stop even after a failed
start. No runner-only path is required.

No suite declares runner `services:`. Upstream v13.2.0/v13.2.1 skip empty images at
[run_context.go:558](https://code.forgejo.org/forgejo/runner/src/tag/v13.2.1/act/runner/run_context.go#L558),
ignore service setup on host jobs at
[run_context.go:1016](https://code.forgejo.org/forgejo/runner/src/tag/v13.2.1/act/runner/run_context.go#L1016),
and omit `job.services` at
[run_context.go:1498](https://code.forgejo.org/forgejo/runner/src/tag/v13.2.1/act/runner/run_context.go#L1498).
The managed lifecycle uses none of those paths. Go/Rust keep Windows tests separate
from the Linux service variant.

The held PR's two matrix jobs each connect over real TCP to all three services at
once, using a Docker-event barrier to prove overlapping lifetimes without port/name
collisions. A separate test runs the pinned deployed runner image's executor on the
same host-networked daemon, interrupts an actual job after all three services are
healthy, and asserts that always()/cancelled() ran and left no owned resources.
Its outer always() cleanup also covers interruption of the test itself.

## PR packaging inputs

`release.package` gates check-build/check-package; `release.build` remains the broad
source input set for merge/dispatch publication. PR packaging signs and verifies
the assembled assets with the same Linux signer and version used by its build,
without staging or publishing a release. A source-only edit does not build
any release target on its PR. Toolchain tests already compile that code.

Packaging reads release settings from `.ci.json` semantically, ignoring unrelated
check/service/docs settings. It reads selected builders' dependency locks, declared
release dependency locks and archive sources, ci/build/, ci/package/, scripts/build*
and scripts/package*, packaging/, installer/, manifests, resource scripts/icons,
MSIX/WiX/NSIS/Inno inputs and syso resources. Add genuinely custom release-only inputs
with `inputs.release.package`. Selected builders also name CMake configure/install
scripts, .NET projects/props/targets, and Python build metadata. Npm package manifests
compare prebuild/build/postbuild and identity, ignoring test/lint script changes;
only the declared npm package directories participate. Cargo TOML is parsed: feature/profile changes trigger
packaging, while ordinary dependency-table/formatting changes alone do not. A joined
image additionally names Dockerfile, .dockerignore and ci/smoke/ as packaging inputs.

## Last consumer edit

All rows receive default automatically, remove copied checks, use job-level guards
in any retained worker, and declare custom data inputs. Each listed migration is
performed later in its own repository. No consumer edit is made in this PR.

| Repo | Additional suites | Required convention/data changes |
|---|---|---|
| at-home-tools | go, release | cmd layout; target/package selections for owned and agent-tools commands; GUI list; shared stamp variable names; manifest convention; private deps automatic |
| at-claude | go, release | root main to cmd/at-claude; Windows/amd64 target; Linux cross-build/signing preserved |
| fzt | go, release | cmd executable or source/module artifact selection; release version data; remove copied builds |
| fzt-automate | go, release | main to cmd; Windows/Linux/darwin pairs; mirror:true; dependency dispatch moves to go/dependencies.yml |
| fzt-browser | go, release | main to cmd; packaged JS/CSS explicit; release dependencies and source assets declared |
| fzt-terminal | go, release | standard command, Go js/wasm and native Windows C-shared targets; remove the duplicate DLL check |
| fzt-picker | go, rust, release | root Go/Cargo workspaces for frontend/windows; joined assets; Darwin/arm64 frontend cross-build on Linux (its origin macos.yml already sets CGO_ENABLED=0); native Windows C-shared part; release dependency data |
| guitar-tabs | go, release | main to cmd/guitar-tabs; replace dispatch-only artifact build |
| gvoice-tui | go, release | main to cmd/gvoice-tui; packaged inputs named |
| recorder | go, release | main to cmd/recorder; Wine contract remains the listed unique check |
| shows | go, rust, web-app, release | root workspace for desktop-rs; npm directories; libmpv as pinned dependency; one draft |
| shows-remote | rust, release | workspace already root; private/native dependency inputs named |
| spotify-player | rust, cluster-service, release | per-target features; fzt.dll dependency; Rust lints; release.image=cluster; Dockerfile consumes the assembled Linux binary; image ABI base must support that binary's libc |
| string-lab | rust, release | included assets/build.rs data named; remove target-cache copy |
| tuimail | rust, release | Linux service tests and requested Windows tests separated; macOS external part |
| guitar-looper-cli | rust, release | ONNX runtime/model as pinned inputs; build.rs consumes vendor paths; tuner/looper in one draft |
| power-lines-gba | rust, release | host workspace; unique ROM worker part; ZIP/RSA signing shared |
| fisch | rust, release | root workspace includes coach; model as pinned input; no bespoke release publisher |
| fzt-desktop | web-app, rust, release | root Cargo workspace; native Tauri package is a unique worker part |
| at | powershell, release | powershell builder packages commands; commands.json and RSA ZIP are shared |
| at-tmux | cmake, release | ci preset/install rules; native Windows SDK; only bidirectional sync remains separate |
| at-terminal | cmake, release | register portable/native CMake tests where applicable; unique MSIX/WinRT part |
| spirelens | go, dotnet, release | root solution, locked packages; core tests standard; Steam/game-specific part only |
| mgba | cmake, release | CMake wrapper/preset pins its upstream source and patches and registers install/tests; no copied CMake CI |
| toad | python, release | frozen uv lock with ruff/pytest; wheel/sdist builder |
| avatars | go, cluster-service | isolated Linux Postgres; terminating image self-test includes migrations/sign-in gate; named COPY inputs |
| home-hub | go, cluster-service | standard root module and image self-test; full image pin |
| session-index | go, cluster-service | isolated Manticore; standard self-test and pin |
| forgejo | cluster-service, python, release | manifests/shared Python validation; engine-specific source/runner smoke worker; same receipt publisher |
| merge-queue | go, cluster-service | root module/self-test; pin PR with Forgejo auto-merge |
| fzt-frontend | go, web-app, cluster-service | root module/npm paths; Forgejo image publication only; retire-azure is the listed exceptional dispatch |
| artifact-keeper | cluster-service | renders; upstream-specific smoke remains the listed unique check |
| ntfy | cluster-service | renders; upstream-specific smoke remains the listed unique check |
| openbao | cluster-service | both values sets; upstream-specific smoke remains the listed unique check |
| torrent | cluster-service | render and VPN-specific smoke remains the listed unique check |
| home-cluster | cluster-service | enumerate every Argo application render; bootstrap remains unique |
| jellyfin | cluster-service | enumerate both values sets; application assertions move to project tests |
| openproject | cluster-service | enumerate both values sets; application assertions move to project tests |
| nas-backup | cluster-service | render paths; job-specific assertions move to project tests |
| pcloud-sync | cluster-service | render paths; sync-specific assertions move to project tests; default branch comes from event |
| ambience | go, web-app, tofu | root modules/packages and named COPY; ACR/container deployment data |
| auth | go, web-app, tofu, release | joined Windows client and server image; release.image=web; one draft and auto-merged/declarative deployment |
| chess-tactics | web-app, tofu | npm paths; isolated Postgres; image self-test; remove dead BGM sync |
| kill-me | web-app, tofu | backend/frontend src/test layout; named COPY/full pin; semantic app version policy remains unique |
| landing-page | web-app, tofu | pinned fzt-browser/string-box inputs; full pin; remove merge polling |
| my-homepage | web-app, tofu | pinned fzt-browser inputs; full pin; remove merge polling |
| eight-queens | web-app, tofu | npm conventions; shared web.staticApp/resourceGroup deploy; remove DNS loop/dead lock updater |
| lights | web-app, tofu | npm conventions; shared web.staticApp/resourceGroup deploy; remove dead lock updater |
| infra-bootstrap | web-app, tofu | npm only if present; relevant tofu gates; Argo bootstrap remains unique |
| shell-config | powershell | pwsh/5.1 parsing; config delivery unchanged pending Nelson's decision |
| shell-config-profile-1 | powershell | pwsh/5.1 data; same deferred delivery |
| shell-config-profile-5 | powershell | pwsh/5.1 data; same deferred delivery |
| shell-config-profile-home | powershell | pwsh/5.1 data; authorized NAS update and delivery deferred unchanged |
| journal-* including journal-music | docs | required README/INDEX/CLAUDE/gear/accounts; optional source release |
| emulation-screensaver | docs | required guides named; source asset policy |
| ux-journal | docs | Markdown style assertions become project validation tests |
| street-fighter-reference | docs | HTML validation in project tests; Pages completion callback only |
| macrocraft | default only | unique Godot editor-plugin check below |
| sf6-nelson-lab | python | JSON/Lua domain assertions become pytest tests; frozen uv lock |
| shell-config-profile-3 | default only | unique POSIX/plist validation below |
| spire-pad | dotnet, release | root solution/project and package lock; Windows tests requested explicitly |
| spirelens-mcp | dotnet, python, release | root solution and Python project list including mcp; locked restores; joined .NET/Python parts |
| string-box | default only | unique Teensy/PlatformIO build below |
| at-protocol | cmake, release | C99 tests/install registered in ci preset, Linux/Windows matrix |
| pipeline-templates | default only | action/suite implementation self-tests remain here |

crenellation stays out of scope; devctl is retired. No joined publisher, Go/Rust/npm
artifact join, macOS wait, private Go fetch, source-release dispatch, dependency
refresh, cross-repo asset fetch or common signing job is retained as a one-off.

### Remaining unique operations

This is the complete retained-operation list; it does not authorize keeping the rest
of a repo's old workflow. Unique artifact builders feed the same release receipt
contract. Input guards and PR/default-branch splitting still apply.

| Repo(s) | Unique operation and why another current repo cannot share that operation |
|---|---|
| at-terminal | Windows Terminal WinRT/MSIX/container packaging and UI conformance; no other app builds that native application/SDK package |
| forgejo | patched server+runner/sidecar builds and nested CI-engine/configure-job/cancellation smoke; only this repo is the CI engine under test |
| fzt-desktop | Tauri IPC/installer packaging; it alone uses the Tauri host |
| power-lines-gba | nightly GBA ROM/toolchain/emulator contract; it alone targets that cartridge ABI (archive/sign/publish are shared) |
| spirelens | Slay the Spire game-version assembly/mod and Steam Workshop upload; other .NET apps have no game/Workshop contract; any still-required KeyVault alias maintenance stays an explicit dispatch |
| recorder | Wine/WASAPI recording/playback contract, not a repeated Go unit-test job; other Go apps do not implement that capture engine |
| at-tmux | bidirectional non-forced GitHub fast-forward and its conflict alert; other mirrors are unidirectional push requests handled by release.mirror |
| artifact-keeper | cache protocol/upstream-image behavior specific to the artifact server |
| ntfy | upstream notification/auth behavior specific to ntfy |
| openbao | seal/bootstrap/JWT-policy behavior specific to the vault |
| torrent | VPN-bound egress/kill-switch behavior specific to the torrent workload |
| home-cluster, infra-bootstrap | Argo/cluster bootstrap ownership and infrastructure adoption; ordinary service repos only render/deploy their own app |
| kill-me | its explicit release:major/minor/patch/none application-version contract; other current apps use numbered build series |
| street-fighter-reference | GitHub Pages publication completion; no other inventory repo uses Pages; reporting replaces polling |
| macrocraft | Godot editor-plugin integration; the inventory's other Godot-related app is a compiled game mod, not this editor plugin |
| shell-config-profile-3 | zsh/bash/plist file validation; it alone contains this POSIX profile kind |
| string-box | Teensy/PlatformIO firmware; no other repo targets that board/toolchain |
| pipeline-templates | action/setup/suite executor tests; only this repo implements these actions |

Home-sync/config-merge delivery is explicitly deferred by Nelson and unchanged,
including its existing wake/retry. This review does not choose its delivery model.

## Pilot proof and unfinished scope

CMake/.NET/Python scripts, cross-target/GUI Go builds, manifest embedding, Linux
Authenticode/ZIP signatures, receipt callbacks and native-service behavior are
exercised by this held PR's Linux/Windows fixtures. No Docker build runs on nelsonpc.

After the Forgejo topic patch, pilots still prove workflow discovery/identity, required
status globs, checkout/token/event correctness, actual publication grants and cancellation:

- at-claude: Go scope/cache, cross-Windows release on Linux and correct signed assets.
- spotify-player: OS/feature matrix, concurrent kept targets, joined Linux/Windows/image
  release, dependency DLL, and cleanup. Validate the final image's libc boundary.
- avatars: isolated Postgres, DNS, real sign-in smoke, renders/digests, OpenBao identity,
  published digest and auto-merge pin. TCP reachability and cleanup are exercised in this PR.
- kill-me: frontend/backend/tofu skips, ACR identity, real plan/apply scope and auto-merge pin.
- journal-music: required guides, deleted local targets, source release and no push checks.
- shell-config-profile-5: Linux pwsh 7, optional Windows 5.1, JSON/docs skips; delivery deferred.

GitHub build/callback reachability and real credentials are proven later in tuimail; fzt-picker's CGO-free Darwin frontend uses the Linux Go cross-builder. Matrix expansion is exercised in this repo's normal CI; suite injection remains
pilot proof. Service isolation and cancellation cleanup are exercised on the current host-networked runner.

Static Web Apps use web.staticApp, web.resourceGroup and one web.packages entry;
the shared Linux publish job builds once, uploads with the digest-pinned Azure client
and stages its bundle. The token stays in process environment.
No live runner or cluster configuration is changed here.

<!-- asset-contract-audit:start -->

## Published asset compatibility audit

This audit read all 76 current home repositories matching the inventory/conventions and their origin default branches. 50 have published releases; 25 attach assets. The current published names and home-sync requirements are captured in [asset-contracts.json](tests/asset-contracts.json). The home-sync input is [machine/state.json](https://forgejo.romaine.life/romaine-life/shell-config-profile-home/src/branch/main/machine/state.json), blob `230ef5a20ab9c76ae727874f9b532c90f7638c06`. No consumer is edited here.

The JSON below is the naming/packaging portion of the migration .ci.json, merged with the project paths, pinned dependencies, features, publication grants and input sets required earlier. Go cmd names and Cargo binary/library names must follow those source conventions. The audit test passes representative builder outputs through the real archive/rename/metadata code and checks every existing attached name and every home-sync asset requirement. It tests the naming boundary, not compilation of all consumer source trees.

Standard Go OS/architecture names already match at-claude, auth, fzt-automate, guitar-tabs, gvoice-tui and recorder. Rust Windows/Linux targets now derive the same OS/architecture naming where possible, preserving fisch, shows-remote, string-lab and the looper/tuner executables. PowerShell keeps at-commands.zip. The other rows need the shown rename/packaging data or declared genuine worker outputs. Shared ZIP signature sidecars and joined image.txt pins may be additive; no existing consumer asset is removed.

### nelsong6/at-terminal

Observed release: [v1.25.30.0](https://forgejo.romaine.life/nelsong6/at-terminal/releases/tag/v1.25.30.0). Assets: `at-protocol.txt`, `at-terminal.cer`, `at-terminal_1.25.30.0_x64.msix`.

The documented genuine worker keeps its existing payload format. Its declared asset names expand {tag}/{version}; complete-external applies an optional per-part assetNames map and reports the uploaded attachment receipt to Forgejo.

```json
{
  "version": 1,
  "release": {
    "toolchains": [],
    "external": [
      {
        "id": "msix",
        "provider": "forgejo",
        "repository": "nelsong6/at-terminal",
        "workflow": "ci.yml",
        "assets": [
          "at-protocol.txt",
          "at-terminal.cer",
          "at-terminal_{version}_x64.msix"
        ]
      }
    ]
  }
}
```

### nelsong6/at-tmux

Observed release: [v3.6a.45](https://forgejo.romaine.life/nelsong6/at-tmux/releases/tag/v3.6a.45). Assets: `at-protocol.txt`, `tmux-windows-v3.6a.45.zip`, `tmux-windows-v3.6a.45.zip.sha256`.

CMake installs the runtime and ABI text under its install root; mapping the directory produces a ZIP, while the ABI text is also a loose asset.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "cmake"
    ],
    "assetNames": {
      "cmake": {
        "cmake/at-protocol.txt": "at-protocol.txt",
        "cmake": "tmux-windows-{tag}.zip"
      }
    },
    "checksumFiles": [
      "tmux-windows-{tag}.zip"
    ]
  },
  "cmake": {
    "buildPlatform": "windows-latest"
  }
}
```

### nelsong6/fisch

Observed release: [v0.1.1](https://forgejo.romaine.life/nelsong6/fisch/releases/tag/v0.1.1). Assets: `fisch-coach-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ]
  }
}
```

### nelsong6/forgejo

Observed release: [runner-v13.2.1.1](https://forgejo.romaine.life/nelsong6/forgejo/releases/tag/runner-v13.2.1.1). Assets: `forgejo-runner-v13.2.1.1-windows-amd64.exe`.

The documented genuine worker keeps its existing payload format. Its declared asset names expand {tag}/{version}; complete-external applies an optional per-part assetNames map and reports the uploaded attachment receipt to Forgejo.

```json
{
  "version": 1,
  "release": {
    "toolchains": [],
    "external": [
      {
        "id": "engine",
        "provider": "forgejo",
        "repository": "nelsong6/forgejo",
        "workflow": "ci.yml",
        "assets": [
          "forgejo-{tag}-windows-amd64.exe"
        ]
      }
    ]
  }
}
```

### nelsong6/guitar-looper-cli

Observed release: [glc-1ed06c0](https://forgejo.romaine.life/nelsong6/guitar-looper-cli/releases/tag/glc-1ed06c0). Assets: `beat_this_final0.onnx`, `looper-windows-amd64.exe`, `onnxruntime.dll`, `tuner-windows-amd64.exe`.

Keep the model and runtime as pinned release.dependencies with their current bare destination names; they are not renamed Rust build outputs.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ]
  }
}
```

### nelsong6/shows

Observed release: [v0.1.2](https://forgejo.romaine.life/nelsong6/shows/releases/tag/v0.1.2). Assets: `shows-desktop-windows-amd64.zip`.

Preserve the pinned libmpv dependency and its DLL name; archive sources are consumed, so a second loose copy is not assembled.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ],
    "archives": [
      {
        "toolchain": "rust",
        "targets": [
          "x86_64-pc-windows-msvc"
        ],
        "name": "shows-desktop-windows-amd64.zip",
        "sources": [
          "dist/shows-desktop-x86_64-pc-windows-msvc.exe",
          "dist/libmpv-2.dll"
        ],
        "entries": {
          "shows-desktop-x86_64-pc-windows-msvc.exe": "shows-desktop.exe"
        }
      }
    ]
  }
}
```

### nelsong6/shows-remote

Observed release: [v0.1.0](https://forgejo.romaine.life/nelsong6/shows-remote/releases/tag/v0.1.0). Assets: `shows-remote-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ]
  }
}
```

### nelsong6/spotify-player

Observed release: [v0.25.1.2](https://forgejo.romaine.life/nelsong6/spotify-player/releases/tag/v0.25.1.2). Assets: `fzt.dll`, `session-release.json`, `session-sources.txt`, `spotify_player`, `spotify_player.exe`.

The fzt.dll dependency belongs only to the Windows target (toolchain rust, targets [x86_64-pc-windows-msvc], destination dist/fzt.dll); keep its existing fzt.lock and checksum-pinned URL. The source list comes from Cargo depfiles, and finalize writes the existing tag/commit/files manifest after signing.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-unknown-linux-gnu"
      },
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ],
    "assetNames": {
      "rust-x86_64-unknown-linux-gnu": {
        "spotify_player-x86_64-unknown-linux-gnu": "spotify_player"
      },
      "rust-x86_64-pc-windows-msvc": {
        "spotify_player-x86_64-pc-windows-msvc.exe": "spotify_player.exe"
      }
    },
    "sourceLists": {
      "rust-x86_64-unknown-linux-gnu": "session-sources.txt"
    },
    "manifest": "session-release.json"
  }
}
```

### romaine-life/at

Observed release: [v0.1.9](https://forgejo.romaine.life/romaine-life/at/releases/tag/v0.1.9). Assets: `at-commands.zip`, `at-commands.zip.signature.json`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "powershell"
    ]
  }
}
```

### romaine-life/at-claude

Observed release: [v0.1.92](https://forgejo.romaine.life/romaine-life/at-claude/releases/tag/v0.1.92). Assets: `at-claude-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/at-home-tools

Observed release: [v1.0.304](https://forgejo.romaine.life/romaine-life/at-home-tools/releases/tag/v1.0.304). Assets: `activity.exe`, `agent-guidance-darwin-amd64`, `agent-guidance-darwin-arm64`, `agent-guidance-linux-amd64`, `agent-guidance.exe`, `alerts.exe`, `claude-pane.exe`, `claude-transcripts.exe`, `cursor-record.exe`, `event-logs.exe`, `forgejo-move.exe`, `home-sync.exe`, `homesvc-linux-amd64`, `homesvc.exe`, `ics-to-gcal.exe`, `log-search.exe`, `log-ship.exe`, `menu-save.exe`, `nas.exe`, `op-machine.exe`, `owner-guard.exe`, `pcloud-backup.exe`, `pr-create.exe`, `pr-edit.exe`, `pr-logs.exe`, `pr-merge.exe`, `pr-ready.exe`, `pr-status.exe`, `pr-watch.exe`, `prompt-links.exe`, `router-agent-linux-arm64`, `router.exe`, `session-search.exe`, `strip-owner.exe`, `tmux-strip.exe`, `tmux-throwaway.exe`, `where-nelson.exe`, `window-shot.exe`, `worktree.exe`, `wp.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64"
      },
      {
        "goos": "darwin",
        "goarch": "amd64"
      },
      {
        "goos": "darwin",
        "goarch": "arm64"
      },
      {
        "goos": "linux",
        "goarch": "amd64"
      },
      {
        "goos": "linux",
        "goarch": "arm64"
      }
    ],
    "assetNames": {
      "go-windows-amd64": {
        "*-windows-amd64.exe": "*.exe"
      }
    }
  }
}
```

### romaine-life/auth

Observed release: [v0.1.55](https://forgejo.romaine.life/romaine-life/auth/releases/tag/v0.1.55). Assets: `romaine-auth-darwin-amd64`, `romaine-auth-darwin-arm64`, `romaine-auth-linux-amd64`, `romaine-auth-linux-arm64`, `romaine-auth-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "darwin",
        "goarch": "amd64"
      },
      {
        "goos": "darwin",
        "goarch": "arm64"
      },
      {
        "goos": "linux",
        "goarch": "amd64"
      },
      {
        "goos": "linux",
        "goarch": "arm64"
      },
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/fzt-automate

Observed release: [v0.1.140](https://forgejo.romaine.life/romaine-life/fzt-automate/releases/tag/v0.1.140). Assets: `fzt-automate-darwin-arm64`, `fzt-automate-linux-amd64`, `fzt-automate-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "darwin",
        "goarch": "arm64"
      },
      {
        "goos": "linux",
        "goarch": "amd64"
      },
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/fzt-browser

Observed release: [v0.1.102](https://forgejo.romaine.life/romaine-life/fzt-browser/releases/tag/v0.1.102). Assets: `fzt-dom-renderer.js`, `fzt-terminal.css`, `fzt-terminal.js`, `fzt-web.js`, `fzt.wasm`.

Move the four static JS/CSS files into release/assets/go/. The Go target builds the standard cmd/fzt WASM entry; static release payloads are copied once by part.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "js",
        "goarch": "wasm",
        "packages": [
          "./cmd/fzt"
        ]
      }
    ],
    "assetNames": {
      "go-js-wasm": {
        "fzt-js-wasm": "fzt.wasm"
      }
    }
  }
}
```

### romaine-life/fzt-desktop

Observed release: [v0.1.0](https://forgejo.romaine.life/romaine-life/fzt-desktop/releases/tag/v0.1.0). Assets: `fzt-desktop.exe`, `fzt-desktop_0.1.0_x64-setup.exe`, `fzt-desktop_0.1.0_x64_en-US.msi`.

The documented genuine worker keeps its existing payload format. Its declared asset names expand {tag}/{version}; complete-external applies an optional per-part assetNames map and reports the uploaded attachment receipt to Forgejo.

```json
{
  "version": 1,
  "release": {
    "toolchains": [],
    "external": [
      {
        "id": "tauri",
        "provider": "forgejo",
        "repository": "romaine-life/fzt-desktop",
        "workflow": "ci.yml",
        "assets": [
          "fzt-desktop.exe",
          "fzt-desktop_{version}_x64-setup.exe",
          "fzt-desktop_{version}_x64_en-US.msi"
        ]
      }
    ]
  }
}
```

### romaine-life/fzt-picker

Observed release: [v0.1.131](https://forgejo.romaine.life/romaine-life/fzt-picker/releases/tag/v0.1.131). Assets: `fzt-files.exe`, `fzt-picker-frontend-darwin-arm64`, `fzt-picker-frontend.exe`, `fzt-picker.exe`, `fzt_picker_frontend.dll`, `fzt_picker_hook.dll`, `fzt_picker_shim.dll`, `test-trigger.exe`.

Expose the frontend commands and C-shared package under the listed cmd names. Rust builds workspace cdylibs as well as executables; only the C-shared Go part needs Windows.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go",
      "rust"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64",
        "packages": [
          "./cmd/fzt-picker-frontend",
          "./cmd/fzt-files"
        ]
      },
      {
        "goos": "darwin",
        "goarch": "arm64",
        "packages": [
          "./cmd/fzt-picker-frontend"
        ]
      },
      {
        "goos": "windows",
        "goarch": "amd64",
        "buildmode": "c-shared",
        "packages": [
          "./cmd/fzt-picker-cgo"
        ]
      }
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ],
    "assetNames": {
      "go-windows-amd64": {
        "*-windows-amd64.exe": "*.exe"
      },
      "go-windows-amd64-c-shared": {
        "fzt-picker-cgo-windows-amd64.dll": "fzt_picker_frontend.dll"
      },
      "rust-x86_64-pc-windows-msvc": {
        "*-windows-amd64.exe": "*.exe",
        "*-windows-amd64.dll": "*.dll"
      }
    }
  }
}
```

### romaine-life/fzt-terminal

Observed release: [v0.1.171](https://forgejo.romaine.life/romaine-life/fzt-terminal/releases/tag/v0.1.171). Assets: `fzt-darwin-arm64`, `fzt-linux-amd64`, `fzt-windows-amd64.dll`, `fzt-windows-amd64.dll.sha256`, `fzt-windows-amd64.exe`.

The C ABI export package fits cmd/fzt-dll; its Windows-only native C-shared job replaces the copied DLL build. The checksum is generated after signing.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64",
        "packages": [
          "./cmd/fzt"
        ]
      },
      {
        "goos": "linux",
        "goarch": "amd64",
        "packages": [
          "./cmd/fzt"
        ]
      },
      {
        "goos": "darwin",
        "goarch": "arm64",
        "packages": [
          "./cmd/fzt"
        ]
      },
      {
        "goos": "windows",
        "goarch": "amd64",
        "buildmode": "c-shared",
        "packages": [
          "./cmd/fzt-dll"
        ]
      }
    ],
    "assetNames": {
      "go-windows-amd64-c-shared": {
        "fzt-dll-windows-amd64.dll": "fzt-windows-amd64.dll"
      }
    },
    "checksumFiles": [
      "fzt-windows-amd64.dll"
    ]
  }
}
```

### romaine-life/guitar-tabs

Observed release: [v0.1.24](https://forgejo.romaine.life/romaine-life/guitar-tabs/releases/tag/v0.1.24). Assets: `guitar-tabs-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/gvoice-tui

Observed release: [v0.1.11](https://forgejo.romaine.life/romaine-life/gvoice-tui/releases/tag/v0.1.11). Assets: `gvoice-tui-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/mgba

Observed release: [v0.11.9179.0](https://forgejo.romaine.life/romaine-life/mgba/releases/tag/v0.11.9179.0). Assets: `mGBA-LICENSE.txt`, `mGBA.exe`, `nointro.dat`.

Install only the runtime, data and license at the CMake install root; the map extracts those files instead of publishing a directory archive.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "cmake"
    ],
    "assetNames": {
      "cmake": {
        "cmake/*": "*"
      }
    }
  },
  "cmake": {
    "buildPlatform": "windows-latest"
  }
}
```

### romaine-life/power-lines-gba

Observed release: [v0.1.5](https://forgejo.romaine.life/romaine-life/power-lines-gba/releases/tag/v0.1.5). Assets: `power-lines.zip`, `power-lines.zip.signature.json`.

The documented genuine worker keeps its existing payload format. Its declared asset names expand {tag}/{version}; complete-external applies an optional per-part assetNames map and reports the uploaded attachment receipt to Forgejo.

```json
{
  "version": 1,
  "release": {
    "toolchains": [],
    "external": [
      {
        "id": "rom",
        "provider": "forgejo",
        "repository": "romaine-life/power-lines-gba",
        "workflow": "ci.yml",
        "assets": [
          "power-lines.zip",
          "power-lines.zip.signature.json"
        ]
      }
    ]
  }
}
```

### romaine-life/recorder

Observed release: [v0.1.16](https://forgejo.romaine.life/romaine-life/recorder/releases/tag/v0.1.16). Assets: `recorder-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "go"
    ],
    "goTargets": [
      {
        "goos": "windows",
        "goarch": "amd64"
      }
    ]
  }
}
```

### romaine-life/spirelens

Observed release: [v0.5.2](https://forgejo.romaine.life/romaine-life/spirelens/releases/tag/v0.5.2). Assets: `SpireLens.zip`.

The documented genuine worker keeps its existing payload format. Its declared asset names expand {tag}/{version}; complete-external applies an optional per-part assetNames map and reports the uploaded attachment receipt to Forgejo.

```json
{
  "version": 1,
  "release": {
    "toolchains": [],
    "external": [
      {
        "id": "mod",
        "provider": "forgejo",
        "repository": "romaine-life/spirelens",
        "workflow": "ci.yml",
        "assets": [
          "SpireLens.zip"
        ]
      }
    ]
  }
}
```

### romaine-life/string-lab

Observed release: [v0.1.5](https://forgejo.romaine.life/romaine-life/string-lab/releases/tag/v0.1.5). Assets: `string-lab-windows-amd64.exe`.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-pc-windows-msvc"
      }
    ]
  }
}
```

### romaine-life/tuimail

Observed release: [v0.2.5.1](https://forgejo.romaine.life/romaine-life/tuimail/releases/tag/v0.2.5.1). Assets: `SHA256SUMS`, `tuimail-aarch64-apple-darwin.tar.gz`, `tuimail-aarch64-pc-windows-msvc.zip`, `tuimail-aarch64-unknown-linux-gnu.tar.gz`, `tuimail-x86_64-apple-darwin.tar.gz`, `tuimail-x86_64-pc-windows-msvc.zip`, `tuimail-x86_64-unknown-linux-gnu.tar.gz`.

The ZIP/TAR entries remain tuimail.exe/tuimail. Finalize creates SHA256SUMS from every acknowledged part, including the asynchronous macOS archives; a native job never waits for that worker.

```json
{
  "version": 1,
  "release": {
    "toolchains": [
      "rust"
    ],
    "rustTargets": [
      {
        "target": "x86_64-unknown-linux-gnu"
      },
      {
        "target": "aarch64-unknown-linux-gnu"
      },
      {
        "target": "x86_64-pc-windows-msvc"
      },
      {
        "target": "aarch64-pc-windows-msvc"
      }
    ],
    "archives": [
      {
        "toolchain": "rust",
        "targets": [
          "x86_64-unknown-linux-gnu"
        ],
        "name": "tuimail-x86_64-unknown-linux-gnu.tar.gz",
        "sources": [
          "dist/tuimail-x86_64-unknown-linux-gnu"
        ],
        "entries": {
          "tuimail-x86_64-unknown-linux-gnu": "tuimail"
        }
      },
      {
        "toolchain": "rust",
        "targets": [
          "aarch64-unknown-linux-gnu"
        ],
        "name": "tuimail-aarch64-unknown-linux-gnu.tar.gz",
        "sources": [
          "dist/tuimail-aarch64-unknown-linux-gnu"
        ],
        "entries": {
          "tuimail-aarch64-unknown-linux-gnu": "tuimail"
        }
      },
      {
        "toolchain": "rust",
        "targets": [
          "x86_64-pc-windows-msvc"
        ],
        "name": "tuimail-x86_64-pc-windows-msvc.zip",
        "sources": [
          "dist/tuimail-x86_64-pc-windows-msvc.exe"
        ],
        "entries": {
          "tuimail-x86_64-pc-windows-msvc.exe": "tuimail.exe"
        }
      },
      {
        "toolchain": "rust",
        "targets": [
          "aarch64-pc-windows-msvc"
        ],
        "name": "tuimail-aarch64-pc-windows-msvc.zip",
        "sources": [
          "dist/tuimail-aarch64-pc-windows-msvc.exe"
        ],
        "entries": {
          "tuimail-aarch64-pc-windows-msvc.exe": "tuimail.exe"
        }
      }
    ],
    "checksumManifest": "SHA256SUMS",
    "external": [
      {
        "id": "macos",
        "provider": "github",
        "repository": "romaine-life/tuimail",
        "workflow": "macos.yml",
        "assets": [
          "tuimail-aarch64-apple-darwin.tar.gz",
          "tuimail-x86_64-apple-darwin.tar.gz"
        ]
      }
    ]
  }
}
```

### Releases without attached payload names

[nelsong6/avatars](https://forgejo.romaine.life/nelsong6/avatars), [nelsong6/home-hub](https://forgejo.romaine.life/nelsong6/home-hub), [nelsong6/jellyfin](https://forgejo.romaine.life/nelsong6/jellyfin), [nelsong6/journal-career](https://forgejo.romaine.life/nelsong6/journal-career), [nelsong6/journal-llm-philosophy](https://forgejo.romaine.life/nelsong6/journal-llm-philosophy), [nelsong6/journal-politics](https://forgejo.romaine.life/nelsong6/journal-politics), [nelsong6/journal-psychology-philosophy](https://forgejo.romaine.life/nelsong6/journal-psychology-philosophy), [nelsong6/nas-backup](https://forgejo.romaine.life/nelsong6/nas-backup), [nelsong6/ntfy](https://forgejo.romaine.life/nelsong6/ntfy), [nelsong6/openbao](https://forgejo.romaine.life/nelsong6/openbao), [nelsong6/openproject](https://forgejo.romaine.life/nelsong6/openproject), [nelsong6/pcloud-sync](https://forgejo.romaine.life/nelsong6/pcloud-sync), [nelsong6/session-index](https://forgejo.romaine.life/nelsong6/session-index), [nelsong6/ux-journal](https://forgejo.romaine.life/nelsong6/ux-journal), [romaine-life/ambience](https://forgejo.romaine.life/romaine-life/ambience), [romaine-life/chess-tactics](https://forgejo.romaine.life/romaine-life/chess-tactics), [romaine-life/fzt](https://forgejo.romaine.life/romaine-life/fzt), [romaine-life/fzt-frontend](https://forgejo.romaine.life/romaine-life/fzt-frontend), [romaine-life/infra-bootstrap](https://forgejo.romaine.life/romaine-life/infra-bootstrap), [romaine-life/kill-me](https://forgejo.romaine.life/romaine-life/kill-me), [romaine-life/landing-page](https://forgejo.romaine.life/romaine-life/landing-page), [romaine-life/merge-queue](https://forgejo.romaine.life/romaine-life/merge-queue), [romaine-life/my-homepage](https://forgejo.romaine.life/romaine-life/my-homepage), [romaine-life/spire-pad](https://forgejo.romaine.life/romaine-life/spire-pad), [romaine-life/spirelens-mcp](https://forgejo.romaine.life/romaine-life/spirelens-mcp). These publish images, notes or source tags; the old publisher did not attach a named payload. Configuring an optional source archive later is a new asset, not an existing download contract.

### Repositories without a published release

[nelsong6/artifact-keeper](https://forgejo.romaine.life/nelsong6/artifact-keeper), [nelsong6/emulation-screensaver](https://forgejo.romaine.life/nelsong6/emulation-screensaver), [nelsong6/home-cluster](https://forgejo.romaine.life/nelsong6/home-cluster), [nelsong6/journal-biking](https://forgejo.romaine.life/nelsong6/journal-biking), [nelsong6/journal-dreams](https://forgejo.romaine.life/nelsong6/journal-dreams), [nelsong6/journal-music](https://forgejo.romaine.life/nelsong6/journal-music), [nelsong6/sf6-nelson-lab](https://forgejo.romaine.life/nelsong6/sf6-nelson-lab), [nelsong6/shell-config-profile-2](https://forgejo.romaine.life/nelsong6/shell-config-profile-2), [nelsong6/shell-config-profile-2-forgejo-archive](https://forgejo.romaine.life/nelsong6/shell-config-profile-2-forgejo-archive), [nelsong6/shell-config-profile-3](https://forgejo.romaine.life/nelsong6/shell-config-profile-3), [nelsong6/shell-config-profile-4-forgejo-archive](https://forgejo.romaine.life/nelsong6/shell-config-profile-4-forgejo-archive), [nelsong6/street-fighter-reference](https://forgejo.romaine.life/nelsong6/street-fighter-reference), [nelsong6/torrent](https://forgejo.romaine.life/nelsong6/torrent), [romaine-life/at-protocol](https://forgejo.romaine.life/romaine-life/at-protocol), [romaine-life/diagrams](https://forgejo.romaine.life/romaine-life/diagrams), [romaine-life/eight-queens](https://forgejo.romaine.life/romaine-life/eight-queens), [romaine-life/fzt-showcase](https://forgejo.romaine.life/romaine-life/fzt-showcase), [romaine-life/lights](https://forgejo.romaine.life/romaine-life/lights), [romaine-life/macrocraft](https://forgejo.romaine.life/romaine-life/macrocraft), [romaine-life/pipeline-templates](https://forgejo.romaine.life/romaine-life/pipeline-templates), [romaine-life/shell-config](https://forgejo.romaine.life/romaine-life/shell-config), [romaine-life/shell-config-profile-1](https://forgejo.romaine.life/romaine-life/shell-config-profile-1), [romaine-life/shell-config-profile-5](https://forgejo.romaine.life/romaine-life/shell-config-profile-5), [romaine-life/shell-config-profile-home](https://forgejo.romaine.life/romaine-life/shell-config-profile-home), [romaine-life/string-box](https://forgejo.romaine.life/romaine-life/string-box), [romaine-life/toad](https://forgejo.romaine.life/romaine-life/toad). Their eventual first asset names have no existing release consumer contract in this audit.

<!-- asset-contract-audit:end -->
