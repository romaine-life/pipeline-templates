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

Call one from a job with no `runs-on`, pinned to `main`, inheriting secrets:

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
