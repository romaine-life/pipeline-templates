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
