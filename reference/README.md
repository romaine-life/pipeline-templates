# Reference CI shapes (PIPT-4)

Every home repo's `.forgejo/workflows/ci.yml` is brought to the shape for its kind of
project. These files are copied into a repo and filled in, never called: each repo owns
its CI file, and something only one repo needs is written there. A line here marked with
`echo` is where the repo's own commands go.

| Kind | File | Repos |
|---|---|---|
| Windows app released to the PCs | `windows-app.yml` | at-home-tools, at, at-claude, at-terminal, at-tmux, devctl, fzt, fzt-automate, fzt-browser, fzt-desktop, fzt-picker, fzt-terminal, guitar-looper-cli, guitar-tabs, gvoice-tui, mgba, power-lines-gba, recorder, shows, shows-remote, spirelens, spotify-player, string-lab, toad, tuimail |
| PowerShell config repo | `powershell-config.yml` | shell-config, shell-config-profile-1, shell-config-profile-5, shell-config-profile-home |
| Azure web app | `web-app.yml` | ambience, auth, chess-tactics, crenellation, eight-queens, fzt-frontend, infra-bootstrap, kill-me, landing-page, lights, my-homepage |
| Home-cluster service | `cluster-service.yml` | artifact-keeper, avatars, forgejo, home-cluster, home-hub, jellyfin, nas-backup, ntfy, openbao, openproject, pcloud-sync, session-index, torrent |
| Docs and journals | `docs.yml` | emulation-screensaver, journal-*, street-fighter-reference, ux-journal |
| Anything else | `base.yml` | fisch, macrocraft, pipeline-templates, sf6-nelson-lab, shell-config-profile-3, spire-pad, spirelens-mcp, string-box |

## The shape

- **`changes` always runs.** It runs `check-fetches` and decides which expensive jobs a
  pull request needs. Every PR head and merge commit therefore has statuses; a head with
  none never lands.
- **Only pull requests skip.** A push to the default branch and a manual dispatch run every
  job: strip-owner dispatches a repo's workflows with only `ref` and expects them to build
  and release, and an image tagged by commit must be rebuilt on every merge.
- **Skips are job-level `if:`**, never `paths` on a trigger. A skipped job posts `skipped`,
  which a required check accepts, so jobs keep their names.
- **A job that builds the program** is skipped only when every changed file is
  documentation (`\.md$|^docs/|^LICENSE$`). **A job that checks a closed set of files**
  (a PowerShell parser, a linter) runs only when one of those files, its script or the
  workflow changes. **Gating is for jobs worth skipping**: anything on the shared Windows
  runner, and slow builds. A cheap Linux job (a lint, a few-second test run) may run on
  every PR with no gate, and must when its checks also read documentation (a
  trailing-newline or file-name convention over every file); then `changes` needs no diff
  step.
- **A job that needs a skipped job is skipped too.** That is right on a PR; a job that must
  run anyway says so in its `if:` (`!failure() && !cancelled()`).
- **`concurrency` never cancels a run on the default branch.** Forgejo otherwise cancels a
  merge's run when the next merge lands, and strip-owner reads the cancelled run as a
  failed release. **A repo whose jobs start containers or services never cancels at all**
  (`cancel-in-progress: false`): a cancelled job skips its cleanup steps, `if: always()`
  included, and leaves them running on the runner. A repo that keeps its own concurrency
  group (one shared by every run) keeps it.
- **A step that publishes on a push also publishes on a dispatch of the default branch**
  (`github.event_name != 'pull_request' && github.ref == 'refs/heads/main'`): strip-owner
  restarts a merge run that never started by dispatching it.
- **Required checks** on the default branch are every job of the shape, in every repo.

## Converging a repo

1. Copy its kind's file over `ci.yml`, move the repo's own steps into it, and delete the
   workflows it replaces. Keep `release.yml` and `dispatch.yml` by those names when the
   repo has them; strip-owner finds them by name. A Windows app that releases through a
   dispatch-only `release.yml` keeps doing so: `ci.yml` builds and signs the same program
   on pull requests and has no Release step or home-sync job (guitar-tabs).
   Keep the repo's existing `permissions:`: a block added or narrowed is proven only by
   the next real release or deploy.
2. Use the repo's default branch in `push.branches` (spotify-player, at-tmux and
   pcloud-sync use `master`).
3. Check that nothing a build reads is documentation (`go:embed`, `include_str!`, a
   packaged `docs/`); if something is, take it out of the skip pattern.
4. Set the required checks to the new job names in the same PR.
5. Verify: the PR runs every job; the next documentation-only PR shows them skipped and
   merges; in a repo that releases, the next release completes.
