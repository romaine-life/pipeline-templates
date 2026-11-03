# pipeline-templates

Pipeline templates that I don't want cluttering up my bootstrap repo.

## Forgejo templates

Repos on Forgejo (https://forgejo.romaine.life) call the templates in
`.forgejo/workflows`:

- `release-and-dispatch-template.yml`: cuts the next `<version-prefix>.N`
  release at HEAD, runs the repo's `artifact-build-workflow` with a `tag`
  input, syncs the GitHub push mirror, and runs `dispatch-workflow` on `main`
  in each `dispatch-repos` repo.
- `go-dependency-update-template.yml`: bumps `modules` in
  `<go-mod-path>/go.mod`, merges the bump through a PR once its checks pass,
  then calls the release template. It takes the same release inputs.

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
```

This runs one linux job on the NAS, wakes treadmill using its state.json wakeMac,
and starts all three PCs' existing tasks concurrently. Manual dispatch verifies it.
It does not install or re-register a task. If a release workflow dispatches a
separate build, put the call after the uploads in that build workflow.

The dedicated forgejo-home-sync Ed25519 private key is generated on the NAS at
/volume1/docker/forgejo/runner-certs/client/home-sync/id_ed25519 (root, mode 400).
The job reads it through the runner's existing /certs/client mount. The
neighboring known_hosts pins the PCs' host keys. Neither file is a workflow
secret or artifact. Only the public key enters ssh.runnerKeys in the home profile.
Both apply.ps1 and home-sync.exe restrict each runner key to exactly
schtasks /run /tn home-sync. The old GitHub runner key remains valid.
The inventory here matches the three machines' sshUser and wakeMac in
shell-config-profile-home/machine/state.json; change both when changing a PC.

Docker's bridge does not forward LAN broadcasts (verified with tcpdump on eth0).
The same key has a second forced entry in Nelson's NAS authorized_keys that runs
only sudo /usr/syno/sbin/synonet --wake E8:FF:1E:D8:9B:FB eth0. The job SSHs to that
entry before treadmill's task request, so the packet originates on the real LAN.
The NAS host key is also pinned in known_hosts. Update that forced wake command
if state.json's wakeMac changes.

The called job also guards the event itself: a manual dispatch starts live tasks.
A caller that publishes all assets on a push to main opts in with
`with: {release-on-push: true}` (at-home-tools). Keep that input false for a
build that only validates main and publishes on dispatch (fzt-picker).
PR validation must never depend only on the wrapper job's
condition being propagated through Forgejo's reusable-workflow expansion. Keep
the caller job unconditional; the callee owns this guard, including on PR builds.
