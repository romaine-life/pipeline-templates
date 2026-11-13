# pipeline-templates

Pipeline templates that I don't want cluttering up my bootstrap repo.

## Fetching nothing from the internet

Home CI fetches actions from Forgejo's mirrors (name them bare: `actions/checkout@v4`) and
everything else through Artifact Keeper at https://artifacts.home.romaine.life, which keeps
serving what it holds when a source is down (FORGEJO-25). Three composite actions:

- `romaine-life/pipeline-templates/actions/check-fetches@main`: a step in a repo's required
  CI job, after its checkout. It fails on a `uses:` with an address that isn't Forgejo's, or
  an http(s) address on a host that isn't Forgejo, `*.home.romaine.life` or local. A line
  that must reach the internet (a deploy to Azure) carries `# internet: <why>`.
- `romaine-life/pipeline-templates/actions/home-cache@main`: points apt, cargo and NuGet at
  Artifact Keeper, for a job that uses them; run it before them. The runners already send
  Go, npm, pip, uv and rustup there.
- `romaine-life/pipeline-templates/actions/azure-cli@main`: puts the Azure CLI on PATH,
  installed from PyPI through Artifact Keeper into the runner's tool cache, for a job that
  calls `az`. Its version is set in the action and moves when there's a reason to.

A tool a job downloads comes from Artifact Keeper's caches: a GitHub release at
`https://artifacts.home.romaine.life/general/github/<owner>/<repo>/releases/download/<tag>/<file>`,
raw.githubusercontent.com at `/general/githubusercontent/<path>`, get.helm.sh at
`/general/helm-downloads/<file>`.

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

## Forgejo templates

Repos on Forgejo (https://forgejo.romaine.life) call the templates in
`.forgejo/workflows`:

- `release-and-dispatch-template.yml`: cuts the next `<version-prefix>.N`
  release at HEAD, runs the repo's `artifact-build-workflow` with a `tag`
  input, syncs the GitHub push mirror, and runs `dispatch-workflow` on `main`
  in each `dispatch-repos` repo.
- `go-dependency-update-template.yml`: a repo's take-up, called from its
  `dispatch.yml`, which strip-owner starts. It closes any take-up still open,
  takes `modules` at their latest in `<go-mod-path>/go.mod`, opens a PR listing
  the commits each carries, has Forgejo merge it once its checks pass, and
  exits without waiting on them. The merge is released the way the repo
  releases every change.

Release workflows inside the private `romaine-life` organization dispatch the
shared release workflow through the authenticated Actions API. Forgejo's
cross-repository `workflow_call` lookup requires a public organization, so it
cannot expand the old shorthand there. No visibility setting needs to change.

Dispatch `.forgejo/workflows/release-and-dispatch-template.yml` in this repo with
`ref: main` and these `inputs`:

- `target-repository`: the caller's `owner/repo`.
- `target-ref`: its branch or commit to release.
- `artifact-build-workflow`: its artifact workflow, such as `build.yml`.
- `dry-run`: `true` validates checkout, API access and tags without publishing;
  `false` creates the release and dispatches the builds.
- `status-sha` (optional): a target commit that receives the `Release validation`
  status and a link to the shared run, including when validation fails.

The target and the template repository both use the existing
`PIPELINE_DISPATCH_TOKEN` org secret. The caller should set a pending
`Release validation` status before submitting a PR dry run; the shared job reports
the result asynchronously, leaving the sole Linux runner available for that job.
The fzt-automate release workflow is the complete caller example.

The `workflow_call` interface remains available for public namespaces:

```yaml
jobs:
  release:
    uses: romaine-life/pipeline-templates/.forgejo/workflows/release-and-dispatch-template.yml@main
    secrets: inherit
    with:
      artifact-build-workflow: build.yml
```

Both need the `PIPELINE_DISPATCH_TOKEN` org secret on romaine-life. The
copies in `.github/workflows` serve repos still on GitHub; the fzt pair goes
once every fzt repo and devctl has moved.

## Home release trigger (HOMECFG-110)

After all release assets are uploaded, add a dependent job:

```yaml
  home-sync:
    needs: build # final asset upload job(s)
    if: github.event_name == 'workflow_dispatch'
    uses: romaine-life/pipeline-templates/.forgejo/workflows/home-sync.yml@main
    secrets: inherit
    with:
      release-tag: ${{ needs.build.outputs.release-tag }}
```

This runs one linux job on the runner `nas` (on the home cluster), wakes treadmill
using its state.json wakeMac, and starts all three PCs' existing tasks concurrently.
Manual dispatch verifies it.
It does not install or re-register a task. If a release workflow dispatches a
separate build, put the call after the uploads in that build workflow.

The dedicated forgejo-home-sync Ed25519 private key is kept in OpenBao
`secret/services/forgejo` (`home-sync-key`). The runner mounts it in every job at
/certs/client/home-sync/id_ed25519 (root, mode 400). The neighboring known_hosts
(`home-sync-known-hosts`) pins the PCs' host keys. Neither file is a workflow
secret or artifact. Only the public key enters ssh.runnerKeys in the home profile.
Both apply.ps1 and home-sync.exe restrict each runner key to exactly
schtasks /run /tn home-sync. The old GitHub runner key remains valid.
The inventory here matches the machines' sshUser and wakeMac in
shell-config-profile-home/machine/state.json; change both when changing a PC.
A PC marked `away` (nelsonlaptop: Wi-Fi, so no wake) that SSH can't reach is logged
and skipped instead of failing the job, and catches up at its next sign-in; any other
failure on it still fails the job.

Docker's bridge does not forward LAN broadcasts (verified with tcpdump on eth0).
The same key has a second forced entry in Nelson's NAS authorized_keys that runs
only sudo /usr/syno/sbin/synonet --wake E8:FF:1E:D8:9B:FB eth0. The job SSHs to that
entry before treadmill's task request, so the packet originates on the real LAN.
The NAS host key is also pinned in known_hosts. Update that forced wake command
if state.json's wakeMac changes.

The called job guards on the explicit `release-tag`: Forgejo reports
`workflow_call` inside a reusable workflow, so it cannot filter using the caller's
push/dispatch event. A release build outputs its tag only after staging every asset.
PRs and validation-only main builds pass an empty tag. Keep the wrapper job
unconditional and let the callee guard on that tag. A direct manual dispatch with
no tag remains the trigger-only smoke test.

For recovery of a complete unpublished draft, manually dispatch this workflow with
`target-repository: owner/repo` and `release-tag: vX.Y.Z`. That explicit cross-repo
request uses the existing PIPELINE_DISPATCH_TOKEN; normal repo calls use their own
GITHUB_TOKEN. Leave both inputs empty to start tasks without publishing anything.
The legacy release-on-push input remains accepted for existing callers but is no
longer used: the nonempty release tag is the release signal.

Configuration repositories call this workflow after a push to their default
branch with `config-merge: true`. The home-profile caller also sets
`update-home-checkout: true`: before starting any PC, a separate restricted SSH
key fast-forwards the NAS checkout from Forgejo. Other configuration repositories
start the PCs without changing that checkout. PR validation requests neither
side effect. The job serializes checkout and task requests.

The checkout key is `/certs/client/home-sync/checkout_id_ed25519`, from the same
OpenBao secret (`home-sync-checkout-key`). Its NAS authorized-key entry forces
only the reviewed Docker/git fast-forward command for
`/volume1/Files/shell-config-profile-home`; callers cannot select a command or
checkout path. The container uses a repository-read-only Forgejo credential,
with automatic git maintenance disabled because Windows worktrees share the
repository. The checkout step rejects any repository other than
`romaine-life/shell-config-profile-home`, and a failed pull prevents the PC tasks
from starting. A manual verification dispatch sets `target-repository` to that
repository and enables `update-home-checkout` and `config-merge`.

Stage every asset in a **draft** release and pass its tag as `release-tag`. The NAS
job publishes the complete draft immediately before its SSH requests. A busy runner
can delay finishing a release, but cannot leave a newly public release waiting in
that queue before the PCs are triggered. The job logs the publication timestamp;
compare it with each PC's started timestamp to measure release delivery.

For an artifact-build consumer, set `draft-release: true` on the release template
(and dependency-update template if used), upload all assets while the release is
draft, and call home-sync after all upload jobs. Both templates default this input
to false, preserving consumers that do not yet use the PC trigger. A failed draft
build stays unpublished; dispatch its artifact build with the same tag to retry.
Never rerun an asset upload over a published release. Omit `release-tag` for the
manual trigger-only smoke test.
Forgejo does not create a git tag for a draft release (checked against the live
API with a temporary unpublished probe, then cleaned up). Draft staging therefore
reserves the immutable tag first, so artifact builds can check it out and a failed
build cannot make a later commit reuse its version.
