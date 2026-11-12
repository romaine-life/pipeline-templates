"""python3 -m unittest discover actions/check-fetches/tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check  # noqa: E402

WORKFLOW = """\
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: https://github.com/actions/setup-go@v5
      - uses: https://forgejo.romaine.life/romaine-life/pipeline-templates/actions/x@main
      - run: curl -fsSL https://github.com/yannh/kubeconform/releases/download/v0.8.0/k.tar.gz
      - run: curl -fsSL https://artifacts.home.romaine.life/general/github/yannh/k.tar.gz
      - run: curl -s http://127.0.0.1:8080/health http://artifact-keeper-backend:8080/x "$B/x"
      - run: az login  # internet: deploys to Azure at https://management.azure.com
      # see https://github.com/foo/bar for why
      - run: curl https://${{ env.HOST }}/x https://$host/y
      - run: git config --global url."$ORG".insteadOf "https://github.com/romaine-life/"
      - run: echo '<a xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://example.org/ns">' https://example.org/fetched
"""


class CheckFetches(unittest.TestCase):
    def run_on(self, files):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, text in files.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text, encoding="utf-8")
            out = {p.relative_to(root).as_posix(): list(check.findings(p, p.read_text())) for p in check.files(root)}
            return out, check.main(["check", str(root)])

    def test_names_internet_uses_and_downloads_only(self):
        out, code = self.run_on({".forgejo/workflows/ci.yml": WORKFLOW})
        self.assertEqual([n for n, _ in out[".forgejo/workflows/ci.yml"]], [5, 7, 14])
        self.assertEqual(code, 1)

    def test_clean_repo_passes(self):
        out, code = self.run_on({".forgejo/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n"})
        self.assertEqual(code, 0)

    def test_reads_github_workflows_only_without_forgejo_ones(self):
        bad = "jobs:\n  a:\n    steps:\n      - uses: https://github.com/a/b@v1\n"
        out, _ = self.run_on({".forgejo/workflows/ci.yml": "on: push\n", ".github/workflows/old.yml": bad})
        self.assertNotIn(".github/workflows/old.yml", out)
        out, code = self.run_on({".github/workflows/old.yml": bad})
        self.assertEqual(code, 1)

    def test_reads_composite_actions(self):
        out, code = self.run_on({"actions/x/action.yml": "runs:\n  steps:\n    - run: wget https://get.helm.sh/helm.tgz\n"})
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
