#!/usr/bin/env python3
"""check.py [repo root]: fails when a workflow or action fetches from the internet.

Home CI fetches actions from Forgejo's mirrors and packages, images and downloads through
Artifact Keeper, which keep serving what they hold when a source is down (FORGEJO-25).
This reads every workflow and action in the repo and names each line that reaches past
them: a `uses:` with an address that isn't Forgejo's, or an http(s) address on a host
that isn't Forgejo, OpenProject (both answer at home), `*.home.romaine.life` or local. A line that must reach the internet (a deploy to Azure, say) carries a
`# internet: <why>` comment, which this accepts. Standard library only, no network.
"""

import re
import sys
from pathlib import Path

HOME = re.compile(r"^(forgejo\.romaine\.life|openproject\.romaine\.life|[a-z0-9.-]+\.home\.romaine\.life|localhost|127\.0\.0\.1|0\.0\.0\.0)$")
USES = re.compile(r"^\s*(-\s+)?uses:\s*['\"]?(?P<ref>[^\s'\"#]+)")
URL = re.compile(r"https?://(?P<host>[^/\s'\"`)\]}>:]+)")
MARK = re.compile(r"#\s*internet:\s*\S")


def files(root):
    """The workflows Forgejo runs and every action the repo defines."""
    forgejo = root / ".forgejo" / "workflows"
    dirs = [forgejo] if forgejo.is_dir() else [root / ".github" / "workflows"]
    found = [p for d in dirs if d.is_dir() for p in sorted(d.iterdir()) if p.suffix in (".yml", ".yaml")]
    for name in ("action.yml", "action.yaml"):
        found += sorted(p for p in root.rglob(name) if ".git" not in p.parts and "node_modules" not in p.parts)
    return found


def findings(path, text):
    for number, line in enumerate(text.splitlines(), 1):
        if MARK.search(line) or line.lstrip().startswith("#"):
            continue
        uses = USES.match(line)
        if uses:
            ref = uses.group("ref")
            if re.match(r"https?://", ref) and not ref.split("/")[2] == "forgejo.romaine.life":
                yield number, f"uses {ref}: name it bare (owner/repo@ref) so it comes from Forgejo's mirror"
            continue
        if "insteadOf" in line:  # a git rewrite away from that address, not a fetch from it
            continue
        for url in URL.finditer(line):
            if re.search(r"xmlns(:\w+)?=['\"]$", line[: url.start()]):  # an XML namespace's name, never fetched
                continue
            host = url.group("host").lower()
            if host.startswith("$") or "{" in host or "." not in host or HOME.match(host):
                continue
            yield number, f"fetches from {host}: go through artifacts.home.romaine.life, or mark the line '# internet: <why>'"


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".")
    bad = 0
    for path in files(root):
        for number, why in findings(path, path.read_text(encoding="utf-8", errors="replace")):
            print(f"{path.relative_to(root).as_posix()}:{number}: {why}")
            bad += 1
    if bad:
        print(f"{bad} line(s) fetch from the internet (pipeline-templates actions/check-fetches)")
        return 1
    print("no workflow or action fetches from the internet")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
