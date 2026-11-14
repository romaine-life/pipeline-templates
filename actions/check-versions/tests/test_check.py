"""python3 -m unittest discover actions/check-versions/tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check  # noqa: E402

OWN_RELEASE = """\
jobs:
  release:
    steps:
      - run: |
          tag=$(git describe --tags --always --abbrev=7)
          $env:SPT_BUILD_VERSION = (git rev-parse --short=7 HEAD).Trim()
          tag="${GITHUB_SHA:0:7}"
          $tag = 'coach-' + $sha.Substring(0,7)
          $Release = 'desktop-' + $releaseSha.Substring(0,7)
          printf 'version=%s\\n' "$GITHUB_SHA"
          "version=$env:GITHUB_SHA" | Add-Content $env:GITHUB_OUTPUT
          $body = @{ tag_name = $tag; target_commitish = $env:GITHUB_SHA }
      - env:
          VERSION: ${{ github.sha }}
          TAG: ${{ inputs.tag || github.sha }}
        run: gh release create "$VERSION"
"""

NUMBERED = """\
jobs:
  release:
    steps:
      - id: version
        uses: romaine-life/pipeline-templates/actions/release-version@main
      - env:
          TAG: ${{ steps.version.outputs.tag }}
        # The release says which commit it was built from.
        run: |
          jq -n --arg tag "$TAG" --arg sha "$GITHUB_SHA" '{tag_name:$tag,target_commitish:$sha,body:("Built from "+$sha)}'
          git tag --points-at HEAD -l 'v0.1.*'
          branch="SPT-35-pin-${GITHUB_SHA:0:7}"  # version-check: a branch name, not a version
          key="${image_sha256:0:12}"
          if reference.shape[:2] != inside.shape: pass
"""


class CheckVersions(unittest.TestCase):
    def run_on(self, files):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, text in files.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text, encoding="utf-8")
            problems = [p for path in check.files(root) for p in check.check_file(path, root)]
            return problems, check.main(["check", str(root)])

    def test_names_every_version_made_from_a_commit_or_outside_the_step(self):
        problems, code = self.run_on({".forgejo/workflows/ci.yml": OWN_RELEASE})
        self.assertEqual(code, 1)
        lines = sorted(int(p.split(":")[1]) for p in problems)
        self.assertEqual(lines, [5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16])

    def test_accepts_the_step_a_marked_line_and_hashes_that_are_not_commits(self):
        problems, code = self.run_on({".forgejo/workflows/ci.yml": NUMBERED})
        self.assertEqual(problems, [])
        self.assertEqual(code, 0)

    def test_reads_the_files_a_build_stamps_from_and_skips_dependencies(self):
        stamp = "const commit = execSync('git rev-parse --short HEAD')\n"
        problems, _ = self.run_on({
            "frontend/vite.config.js": stamp,
            "build/main.go": 'exec.Command("git", "describe", "--tags")\n',
            "app/build.rs": 'Command::new("git").args(["describe", "--always"])\n',
            "scripts/publish.ps1": "$sha = (git rev-parse --short=12 HEAD).Trim()\n",
            "frontend/node_modules/x/vite.config.js": stamp,
            "src/app.ts": stamp,
        })
        self.assertEqual(sorted(p.split(":")[0] for p in problems),
                         ["app/build.rs", "build/main.go", "frontend/vite.config.js", "scripts/publish.ps1"])

    def test_a_github_only_repo_is_read_from_its_github_workflows(self):
        problems, _ = self.run_on({".github/workflows/ci.yml": "      - run: TAG=$(git rev-parse --short=7 HEAD)\n"})
        self.assertEqual(len(problems), 1)


if __name__ == "__main__":
    unittest.main()
