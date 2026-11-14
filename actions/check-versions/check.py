#!/usr/bin/env python3
"""check.py [repo root]: fails when a version, tag or release name is made anywhere but
actions/release-version, or from a commit hash (PIPT-7).

Every home build is numbered by one step, so no version carries a commit and no repo
grows its own scheme. This reads the workflows Forgejo runs, every action the repo
defines, and the files a build stamps a version from (build.rs, vite.config.*, a Go
build/ program, scripts/), and names:
- a workflow or action that creates a tag or release (a `tag_name` it sets, `git tag`,
  `gh release create`) without using actions/release-version or the release template;
- a version made from the commit: `git describe`, `git rev-parse --short`, a commit cut
  short (`${GITHUB_SHA::7}`, `sha.Substring(0, 7)`, `sha[:7]`), or a version or tag set to
  the commit itself (`VERSION: ${{ github.sha }}`).

A line that names a commit for some other reason (a release's notes saying what it was
built from, a branch name) carries a `version-check: <why>` comment, on the line or the
line above, which this accepts.
Standard library only, no network.
"""

import os
import re
import sys
from pathlib import Path

STEP = re.compile(r"^\s*(-\s+)?uses:\s*['\x22]?\S*(actions/release-version|workflows/release-and-dispatch-template\.yml)@", re.M)
CREATES = [
    (re.compile(r"(?<![.\w])tag_name['\"]?\s*[=:]\s*\S"), "sets a release's tag_name"),
    (re.compile(r"\bgit\s+tag\s+(?!-l\b|--list\b|--points-at\b|--contains\b|--sort\b|-n\b)['\"$\w]"), "creates a tag with git tag"),
    (re.compile(r"\b(gh|tea)\s+release\s+create\b"), "creates a release"),
]
COMMIT = [
    (re.compile(r"\bgit\b.*\bdescribe\b"), "git describe names a build after a commit"),
    (re.compile(r"\brev-parse\b.*--short"), "git rev-parse --short is a commit hash"),
    # A name for a commit ends in sha or commit (head_sha, releaseSha, GITHUB_SHA); a
    # content hash (sha256) or a word that merely contains the letters (shape) is not one.
    (re.compile(r"\w*(sha|Sha|SHA)\}?(::|:0:)[0-9]"), "cuts a commit short"),
    (re.compile(r"\b\w*(sha|Sha|SHA|commit|Commit)\b(\)|\.Trim\(\))?\.(Substring|substring|slice|substr)\(\s*0\s*,"), "cuts a commit short"),
    (re.compile(r"\b\w*(sha|Sha|SHA)\b\[\s*0?\s*:\s*[0-9]+\s*\]"), "cuts a commit short"),
    (re.compile(r"(?i)\b\w*(version|tag)\w*['\"]?\s*[:=]\s*['\"]?(\$\{\{\s*(inputs\.\w+\s*\|\|\s*)?github\.sha|\$env:GITHUB_SHA|\$\{?GITHUB_SHA\b)"),
     "sets a version or tag to the commit"),
    # printf 'version=%s\n' "$GITHUB_SHA"
    (re.compile(r"(?i)\b(version|tag)=%s[^'\x22]*['\x22]\s+['\x22]?\$\{?GITHUB_SHA\b"), "sets a version or tag to the commit"),
]
MARK = re.compile(r"version-check:\s*\S")
SKIP = {".git", "node_modules", "target", "vendor", ".claude", "dist", ".venv"}
SCRIPTS = {".ps1", ".sh", ".mjs", ".js", ".cjs", ".py", ".go", ".rs"}


def files(root):
    """Workflows Forgejo runs, the repo's actions, and the files a build stamps from."""
    forgejo = root / ".forgejo" / "workflows"
    workflows = forgejo if forgejo.is_dir() else root / ".github" / "workflows"
    found = set()
    if workflows.is_dir():
        found |= {p for p in workflows.iterdir() if p.suffix in (".yml", ".yaml")}
    for folder, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        parts = Path(folder).relative_to(root).parts
        for name in names:
            path = Path(folder) / name
            if name in ("action.yml", "action.yaml") or name == "build.rs" or name.startswith("vite.config."):
                found.add(path)
            elif path.suffix in SCRIPTS and ("scripts" in parts or (path.suffix == ".go" and "build" in parts)):
                found.add(path)
    return sorted(found)


COMMENT = re.compile(r"^\s*(#|//|/\*|\*|<#)")


def marked(lines, i):
    return MARK.search(lines[i]) or (i > 0 and MARK.search(lines[i - 1]))


def check_file(path, root):
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    rel = path.relative_to(root).as_posix()
    problems = []
    workflowish = path.suffix in (".yml", ".yaml")
    uses_step = bool(STEP.search(text)) or rel.startswith("actions/release-version/")
    for i, line in enumerate(lines):
        if marked(lines, i) or COMMENT.match(line):
            continue
        for pattern, why in COMMIT:
            if pattern.search(line):
                problems.append(f"{rel}:{i + 1}: {why}: {line.strip()}")
                break
        if workflowish and not uses_step:
            for pattern, why in CREATES:
                if pattern.search(line):
                    problems.append(f"{rel}:{i + 1}: {why} without actions/release-version: {line.strip()}")
                    break
    return problems


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".").resolve()
    problems = [p for path in files(root) for p in check_file(path, root)]
    for problem in problems:
        print(f"::error::{problem}")
    if problems:
        print(f"{len(problems)} version(s) made outside actions/release-version or from a commit (PIPT-7). "
              "Number the build with romaine-life/pipeline-templates/actions/release-version@main; "
              "a line that names a commit for another reason carries `version-check: <why>`.")
        return 1
    print(f"Checked {len(files(root))} files: every version comes from actions/release-version")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
