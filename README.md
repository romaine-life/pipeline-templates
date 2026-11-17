# pipeline-templates

Pipeline templates that I don't want cluttering up my bootstrap repo.

## Fetching nothing from the internet

Home CI fetches actions from Forgejo's mirrors (name them bare: `actions/checkout@v4`) and
everything else through Artifact Keeper at https://artifacts.home.romaine.life, which keeps
serving what it holds when a source is down (FORGEJO-25). Composite actions:

- `romaine-life/pipeline-templates/actions/check-fetches@main`: a step in a repo's required
  CI job, after its checkout. It reads the repo's workflows, actions and Dockerfiles, and
  fails on a `uses:` with an address that isn't Forgejo's, an http(s) address on a host that
  isn't Forgejo, `*.home.romaine.life` or local, or an image not named by digest through
  Artifact Keeper (`artifacts.home.romaine.life/<cache>/<image>:<tag>@sha256:<digest>`;
  images the same file builds and our own `forgejo.romaine.life` ones are left alone). It
  also fails on a setup action that downloads from the internet where an action here installs
  through Artifact Keeper (actions/setup-node, setup-python, setup-dotnet, astral-sh/setup-uv,
  opentofu/setup-opentofu, dtolnay/rust-toolchain, azure/setup-kubectl, setup-helm without
  `downloadBaseURL`), on actions/setup-go, whose install has no lock (PIPT-5; this repo's
  `actions/setup-go` replaces it), on `tofu init` or `tofu providers` in a job with no
  home-cache step, and on a Cargo git dependency on a host not at home. A pin moves in a
  commit when there's a reason to, never on its own. A line that must reach the internet (a
  deploy to Azure) carries `# internet: <why>`, in a Dockerfile on the line above; a
  Dockerfile or Cargo.toml home CI never builds says `# check-fetches: not built by home CI`.
- `romaine-life/pipeline-templates/actions/home-cache@main`: points apt, cargo, NuGet and
  OpenTofu's providers at Artifact Keeper, for a job that uses them; run it before them. The
  runners already send Go, npm, pip, uv and rustup there. OpenTofu gets a CLI config
  (`TF_CLI_CONFIG_FILE`) whose only provider source is Artifact Keeper's mirror of
  registry.opentofu.org, so `tofu init` can't reach anything else.
- `romaine-life/pipeline-templates/actions/check-image-digests@main`: a step in a home-cluster
  service's manifests job, after it renders them to files (`manifests:`, files or directories).
  It fails on an `image:` or `imageName:` the rendered manifests run that isn't named by digest
  (`<image>:<tag>@sha256:<digest>`). Manifests keep the registry's own names: the cluster's node
  pulls them through Artifact Keeper by its registry mirrors (home-cluster `vm/user-data.yaml`).
- `romaine-life/pipeline-templates/actions/cached-images@main`: for a job that runs the image a
  manifest names, after the step that puts the names in environment variables (`vars:`, their
  names). It rewrites each to the same image through Artifact Keeper, from Artifact Keeper's own
  list of its Docker caches.
- `romaine-life/pipeline-templates/actions/container-health@main`: for a job that starts a
  container with a health check and then tests it (`container:`, its name; `timeout:`, seconds,
  120 by default). It reads the container's state, then waits on Docker's health events, never
  a retry loop, and fails at once on an unhealthy result or an exit, with the container's last
  health output and log lines.
- `romaine-life/pipeline-templates/actions/azure-cli@main`: puts the Azure CLI on PATH,
  installed from PyPI through Artifact Keeper into the runner's tool cache, for a job that
  calls `az`. Its version is set in the action and moves when there's a reason to.

Toolchains come from the setup actions here, never from `actions/setup-node`,
`setup-python`, `setup-dotnet`, `astral-sh/setup-uv`, `opentofu/setup-opentofu` or
`dtolnay/rust-toolchain` named directly, which download from the internet, nor
`actions/setup-go`, whose install has no lock. Each installs an
exact version through Artifact Keeper, checks it against a published or pinned checksum,
and keeps it in the runner's tool cache, so a version is downloaded once per runner. The
exact versions are pinned in one table, `actions/pins.txt`; a pin moves in a commit when
there's a reason to.

- `actions/setup-node` with `node-version: "22"`: the Node pinned for that major, then
  `actions/setup-node` on it, so `cache: npm` (also an input) works as before.
- `actions/setup-python` with `python-version: "3.12"`: a virtual environment with pip, first
  on PATH, from a Python the pinned uv installs. The patch release is the newest that uv
  knows.
- `actions/setup-uv`: the pinned uv. `enable-cache` and `cache-dependency-glob` are passed
  through.
- `actions/setup-dotnet` with `dotnet-version: "9.0"`: the SDK pinned for that channel, in
  `DOTNET_ROOT` and on PATH, with telemetry and the workload update check off.
- `actions/setup-opentofu` with `tofu-version: 1.11.0`: that exact OpenTofu, with no wrapper.
  Each workflow pins its own version.
- `actions/rust-toolchain`: the pinned stable Rust, or an exact `toolchain` (`1.100.0`,
  `nightly-2026-08-01`), with `components` and `targets`. It sets `RUSTUP_TOOLCHAIN` for the
  job, which overrides a `rust-toolchain.toml`, and leaves the runner's default alone.
- `actions/setup-go`: the exact Go in `go.mod` (`go-version-file`), from its `toolchain` line,
  else its `go` line, which must name a patch release (`go 1.26.1`), checked against its
  published `.sha256`; then `actions/setup-go@v6` on it, with its `cache` off unless a job turns
  it on (PIPT-15). It installs into the tool-cache folder
  setup-go@v6 names for the runners' `GO_DOWNLOAD_BASE_URL`, under a lock: setup-go@v6 on its
  own installs with none, and jobs taking a new version at once can delete it under each
  other (PIPT-5).

Each is named like the others: `romaine-life/pipeline-templates/actions/setup-node@main`.
`actions/setup-go` downloads Go from `GO_DOWNLOAD_BASE_URL`, which every runner points at
Artifact Keeper, and its version comes from each repo's `go.mod` rather than `pins.txt`.

A tool a job downloads comes from Artifact Keeper's caches: a GitHub release at
`https://artifacts.home.romaine.life/general/github/<owner>/<repo>/releases/download/<tag>/<file>`,
raw.githubusercontent.com at `/general/githubusercontent/<path>`, get.helm.sh at
`/general/helm-downloads/<file>`.

## Versions (PIPT-7)

Every home build's version comes from one step, and none carries a commit hash. A release
is numbered `<prefix>.N`: the plain count (`v0.1.12`), or for a fork the upstream version
it's built on (`v0.25.1.4`). A build that isn't released is named after the number it would
take and its PR and run (`v0.1.13-pr152.871`), or its run alone (`v0.1.13-run871`).

```yaml
      - id: version
        uses: romaine-life/pipeline-templates/actions/release-version@main
        with:
          prefix: v0.1                     # or prefix-from: Cargo.toml, CMakeLists.txt, package.json
          # component: coach               # a repo releasing several things: coach-v0.1.N
          # suffix: .0                     # fixed parts after the count: v1.25.N.0
```

On a push to the default branch it reserves the tag on the commit (a commit already numbered
keeps its number) and outputs it as `version` and `tag`; on any other run it reserves
nothing and `tag` is empty. `publish:` overrides that. The build stamps `version`; the
release is created on `tag`.

`romaine-life/pipeline-templates/actions/check-versions@main`, a step in a repo's required
CI job after its checkout (Linux), fails on a workflow or action that creates a tag or
release without the step, and on a version made from a commit: `git describe`,
`git rev-parse --short`, a commit cut short, or a version set to the commit. It reads the
workflows, actions, `build.rs`, `vite.config.*`, a Go `build/` program and `scripts/`. A line
naming a commit for another reason carries `version-check: <why>`.

## Release cleanup (NB-2)

Every release keeps its notes and tag, but only a repo's newest 10 published releases,
and its newest stable one, keep their files: `romaine-life/pipeline-templates/actions/prune-releases@main`
deletes the rest. `home-sync.yml` runs it in its own job after publishing a release, so a
repo released through it needs nothing more. Any other repo whose CI publishes release files
runs it as the last step of its release job, after the release is published:

```yaml
      - uses: romaine-life/pipeline-templates/actions/prune-releases@main
```

It uses the job's own token. A failed cleanup fails that run; the next release's cleanup
catches up on whatever it left.

## Forgejo suites (PIPT-12)

[Suites](suites/README.md) run every home repository's CI.
Forgejo injects top-level workflows by repo topic, and `CI_SUITES_REF` selects a
branch for pilots. GitHub workflows are unchanged.

The reusable `.forgejo/workflows/home-sync.yml` remains unchanged while Nelson decides
its delivery model. Every repository automatically gets `default`; additional topics
select the twelve shared suites, including joined releases across toolchains.
