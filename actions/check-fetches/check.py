#!/usr/bin/env python3
"""check.py [repo root]: fails when CI fetches from the internet or runs an unpinned image.

Home CI fetches actions from Forgejo's mirrors and packages, images and downloads through
Artifact Keeper, which keep serving what they hold when a source is down (FORGEJO-25), and
names every image by digest, so an image changes only in a commit (FORGEJO-29).

This reads every workflow and action in the repo, and every Dockerfile, and names each line
that reaches past them:
- a `uses:` with an address that isn't Forgejo's;
- an http(s) address on a host that isn't Forgejo, OpenProject (both answer at home),
  `*.home.romaine.life` or local;
- an image (a Dockerfile's FROM, a workflow's `image:` or `container:`, `docker://`, or
  `docker run|create|pull`) that isn't named by digest through artifacts.home.romaine.life.
  Images the same file builds, our own forgejo.romaine.life images and names held in a
  variable are left alone;
- a setup action that downloads its tool from the internet, used directly where
  pipeline-templates has one that installs it through Artifact Keeper (setup-helm without
  its downloadBaseURL), and actions/setup-go, whose install has no lock (PIPT-5);
- `tofu init` or `tofu providers` in a job with no home-cache step, which points tofu at
  Artifact Keeper's provider mirror;
- a Cargo git dependency (Cargo.toml `git =`, Cargo.lock `git+`) on a host not at home.

A line that must reach the internet (a deploy to Azure, say) carries a `# internet: <why>`
comment, which this accepts; in a Dockerfile, where a comment can't share a line with an
instruction, it goes on the line above. A Dockerfile or Cargo.toml home CI never builds (one
a fork carries from upstream, a local tool) says so in a `# check-fetches: not built by home
CI` line, and is skipped, with the Cargo.lock beside it.
Standard library only, no network.
"""

import re
import shlex
import sys
from pathlib import Path

HOME = re.compile(r"^(forgejo\.romaine\.life|openproject\.romaine\.life|[a-z0-9.-]+\.home\.romaine\.life|localhost|127\.0\.0\.1|0\.0\.0\.0)$")
USES = re.compile(r"^\s*(-\s+)?uses:\s*['\"]?(?P<ref>[^\s'\"#]+)")
URL = re.compile(r"https?://(?P<host>[^/\s'\"`)\]}>:]+)")
MARK = re.compile(r"#\s*internet:\s*\S")
NOT_BUILT = re.compile(r"^\s*#\s*check-fetches:\s*not built by home CI", re.M)
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
CACHE = "artifacts.home.romaine.life/"
OWN = "forgejo.romaine.life/"

IMAGE_KEY = re.compile(r"^\s*(-\s+)?(image|container):\s*['\"]?(?P<ref>[^\s'\"#]+)['\"]?\s*(#.*)?$")
DOCKER_SCHEME = re.compile(r"docker://(?P<ref>[^\s'\"#]+)")
DOCKER_CMD = re.compile(r"\bdocker\s+(?:container\s+|image\s+)?(?P<verb>run|create|pull)\b(?P<rest>.*)")
# Setup actions that download their tool from the internet, and what to use instead.
TEMPLATES = "romaine-life/pipeline-templates/actions/"
SETUP = {
    "actions/setup-node": TEMPLATES + "setup-node@main",
    "actions/setup-python": TEMPLATES + "setup-python@main",
    "actions/setup-dotnet": TEMPLATES + "setup-dotnet@main",
    "actions/setup-go": TEMPLATES + "setup-go@main",
    "astral-sh/setup-uv": TEMPLATES + "setup-uv@main",
    "opentofu/setup-opentofu": TEMPLATES + "setup-opentofu@main",
    "dtolnay/rust-toolchain": TEMPLATES + "rust-toolchain@main",
    "azure/setup-kubectl": "a curl of artifacts.home.romaine.life/general/k8s-dl/release/<v>/... checked against its .sha256",
}
# Why each is refused, where it isn't that it downloads from the internet.
WHY = {"actions/setup-go": "it installs Go with no lock, so jobs taking a new version at once can delete it under each other"}
# The setup actions pipeline-templates' own wrappers nest, by the wrapper's folder.
WRAPS = {"setup-node": {"actions/setup-node"}, "setup-go": {"actions/setup-go"}, "setup-uv": {"astral-sh/setup-uv"},
         "setup-python": {"astral-sh/setup-uv"}}
TOFU = re.compile(r"(^|[\s;&|(\"'])tofu\s+(\"?-chdir=\S+\s+)?(init|providers)\b")
HOME_CACHE = re.compile(r"(^|/)actions/home-cache(@|$)")
JOB = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")
CARGO_GIT = re.compile(r"^\s*[\w-]+\s*=.*\bgit\s*=\s*['\"](?P<url>[^'\"]+)|^\s*git\s*=\s*['\"](?P<url2>[^'\"]+)")
LOCK_GIT = re.compile(r"^\s*source\s*=\s*\"git\+(?P<url>[^\"?#]+)")
BUILT_TAG = re.compile(r"(?:\s(?:-t|--tag)[\s=]+|^\s*tags:\s*)['\"]?(?P<name>[^\s'\"]+)", re.M)
# docker run/create options that take no value; every other option takes the next word
# unless written `--opt=value`.
FLAGS = {"--rm", "--read-only", "--init", "--privileged", "-d", "--detach", "-i", "-t", "-it", "-ti",
         "-dit", "--interactive", "--tty", "-q", "--quiet", "-a", "--all-tags", "-P", "--publish-all",
         "--disable-content-trust", "--no-healthcheck", "--oom-kill-disable", "--sig-proxy"}


def files(root):
    """The workflows Forgejo runs, every action the repo defines, and every Dockerfile."""
    forgejo = root / ".forgejo" / "workflows"
    dirs = [forgejo] if forgejo.is_dir() else [root / ".github" / "workflows"]
    found = [p for d in dirs if d.is_dir() for p in sorted(d.iterdir()) if p.suffix in (".yml", ".yaml")]
    skip = {".git", "node_modules", ".claude"}
    for name in ("action.yml", "action.yaml", "Cargo.toml", "Cargo.lock"):
        found += sorted(p for p in root.rglob(name) if not skip & set(p.parts))
    found += sorted(
        p for p in root.rglob("*")
        if p.is_file() and not skip & set(p.parts) and is_dockerfile(p)
    )
    return found


def is_dockerfile(path):
    n = path.name
    return n.startswith(("Dockerfile", "Containerfile")) or n.endswith((".Dockerfile", ".dockerfile", ".Containerfile"))


def image_problem(ref):
    """Why an image reference isn't allowed, or None."""
    if ref.startswith(OWN):
        return None
    if not ref.startswith(CACHE):
        return f"image {ref}: pull it through {CACHE}<cache>/... and name it by digest"
    if not DIGEST.search(ref):
        return f"image {ref}: name it by digest (<image>:<tag>@sha256:...), so it changes only in a commit"
    return None


def variable(ref):
    return "$" in ref or ref.startswith("{")


def docker_image(rest):
    """The image a `docker run|create|pull` names, or None when it can't be told."""
    try:
        words = shlex.split(rest, comments=True)
    except ValueError:
        return None
    i = 0
    while i < len(words):
        w = words[i]
        if w in ("|", "&&", ";", ">", "2>&1"):
            return None
        if w.startswith("-"):
            i += 1 if (w in FLAGS or "=" in w) else 2
            continue
        return w
    return None


def url_findings(line):
    uses = USES.match(line)
    if uses:
        ref = uses.group("ref")
        if re.match(r"https?://", ref) and not ref.split("/")[2] == "forgejo.romaine.life":
            yield f"uses {ref}: name it bare (owner/repo@ref) so it comes from Forgejo's mirror"
        return
    if "insteadOf" in line:  # a git rewrite away from that address, not a fetch from it
        return
    for url in URL.finditer(line):
        if re.search(r"xmlns(:\w+)?=['\"]$", line[: url.start()]):  # an XML namespace's name, never fetched
            continue
        host = url.group("host").lower()
        if host.startswith("$") or "{" in host or "." not in host or HOME.match(host):
            continue
        yield f"fetches from {host}: go through artifacts.home.romaine.life, or mark the line '# internet: <why>'"


def joined(text):
    """Lines with shell continuations joined, each kept at the number it starts on."""
    out, buf, start = [], "", None
    for number, line in enumerate(text.splitlines(), 1):
        if start is None:
            start = number
        if line.rstrip().endswith("\\"):
            buf += line.rstrip()[:-1] + " "
            continue
        out.append((start, buf + line))
        buf, start = "", None
    if start is not None:
        out.append((start, buf))
    return out


def setup_problem(ref, nested):
    """Why a `uses:` of a setup action isn't allowed, or None."""
    name = ref.split("@")[0]
    if name in SETUP and name not in nested:
        return f"uses {ref}: {WHY.get(name, 'it downloads from the internet')}; use {SETUP[name]}"
    return None


def units(lines):
    """The lines grouped by job (a workflow's jobs; a whole action is one)."""
    groups, current, in_jobs = [], [], False
    for number, line in lines:
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
        elif in_jobs and JOB.match(line):
            groups.append(current)
            current = []
        current.append((number, line))
    groups.append(current)
    return groups


def job_findings(text):
    """A job that runs tofu init or tofu providers without home-cache, and setup-helm with no downloadBaseURL."""
    lines = list(enumerate(text.splitlines(), 1))
    for unit in units(lines):
        cached = any((u := USES.match(l)) and HOME_CACHE.search(u.group("ref")) for _, l in unit)
        for i, (number, line) in enumerate(unit):
            if line.lstrip().startswith("#") or re.match(r"^\s*(-\s+)?(name|description):", line):
                continue
            if not cached and TOFU.search(line) and not MARK.search(line):
                yield number, "tofu fetches providers from the registry: add romaine-life/pipeline-templates/actions/home-cache@main to the job, or mark the line '# internet: <why>'"
            uses = USES.match(line)
            if uses and uses.group("ref").split("@")[0] == "azure/setup-helm":
                indent = len(line) - len(line.lstrip(" -"))
                step = []
                for _, rest in unit[i + 1:]:
                    if rest.strip() and (len(rest) - len(rest.lstrip(" ")) < indent or rest.lstrip().startswith("- ")):
                        break
                    step.append(rest)
                if not any("downloadBaseURL:" in r for r in step):
                    yield number, "uses azure/setup-helm without downloadBaseURL: set it to https://artifacts.home.romaine.life/general/helm-downloads/"


def cargo_findings(path, text):
    manifest = path.with_name("Cargo.toml")
    if NOT_BUILT.search(text if path.name == "Cargo.toml" else manifest.read_text(encoding="utf-8", errors="replace") if manifest.is_file() else ""):
        return
    pattern = LOCK_GIT if path.name == "Cargo.lock" else CARGO_GIT
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("#") or MARK.search(line):
            continue
        m = pattern.search(line)
        url = m and (m.groupdict().get("url") or m.groupdict().get("url2"))
        if not url:
            continue
        host = URL.match(url)
        if host and not HOME.match(host.group("host").lower()):
            yield number, f"git dependency on {host.group('host')}: keep a copy on forgejo.romaine.life and point Cargo there"


def workflow_findings(text, nested=frozenset()):
    built = {m.group("name").split(":")[0].split("@")[0] for m in BUILT_TAG.finditer(text)}

    def local(ref):
        return variable(ref) or ref.split("@")[0].rsplit(":", 1)[0] in built

    for number, line in joined(text):
        if line.lstrip().startswith("#"):
            continue
        if not MARK.search(line):  # the mark excuses a fetch, never an unpinned image
            yield from ((number, why) for why in url_findings(line))
        uses = USES.match(line)
        if uses:
            why = setup_problem(uses.group("ref"), nested)
            if why:
                yield number, why
        refs = []
        key = IMAGE_KEY.match(line)
        if key:
            refs.append(key.group("ref"))
        refs += [m.group("ref") for m in DOCKER_SCHEME.finditer(line)]
        for m in DOCKER_CMD.finditer(line):
            ref = docker_image(m.group("rest"))
            if ref:
                refs.append(ref)
        for ref in refs:
            why = None if local(ref) else image_problem(ref)
            if why:
                yield number, why


def dockerfile_findings(text):
    if NOT_BUILT.search(text):
        return
    stages, args, marked = set(), {}, False
    for number, line in joined(text):
        stripped = line.strip()
        if stripped.startswith("#"):
            marked = marked or bool(MARK.search(stripped))
            continue
        if not stripped:
            continue
        was_marked, marked = marked, False
        word = stripped.split(None, 1)[0].upper()
        if word == "ARG" and "=" in stripped:
            name, _, value = stripped.split(None, 1)[1].partition("=")
            args[name.strip()] = (number, value.strip().strip("'\""))
        if word == "FROM":
            parts = [p for p in stripped.split()[1:] if not p.startswith("--")]
            ref = parts[0] if parts else ""
            if len(parts) >= 3 and parts[1].upper() == "AS":
                stages.add(parts[2].lower())
            if ref.lower() == "scratch" or ref.lower() in stages:
                continue
            m = re.fullmatch(r"\$\{?(\w+)\}?", ref)
            if m:
                if m.group(1) in args:
                    arg_number, value = args[m.group(1)]
                    why = image_problem(value)
                    if why:
                        yield arg_number, why
                continue
            if variable(ref):
                continue
            why = image_problem(ref)
            if why and not was_marked:
                yield number, why
            continue
        if word == "COPY" and "--from=" in stripped:
            ref = re.search(r"--from=(\S+)", stripped).group(1)
            if ref.lower() not in stages and not ref.isdigit() and not variable(ref):
                why = image_problem(ref)
                if why and not was_marked:
                    yield number, why
        if not was_marked:
            yield from ((number, why) for why in url_findings(line))


def findings(path, text):
    if is_dockerfile(path):
        yield from dockerfile_findings(text)
    elif path.name in ("Cargo.toml", "Cargo.lock"):
        yield from cargo_findings(path, text)
    else:
        nested = WRAPS.get(path.parent.name, frozenset()) if path.name in ("action.yml", "action.yaml") else frozenset()
        yield from sorted(set(workflow_findings(text, nested)) | set(job_findings(text)))


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".")
    bad = 0
    for path in files(root):
        for number, why in findings(path, path.read_text(encoding="utf-8", errors="replace")):
            print(f"{path.relative_to(root).as_posix()}:{number}: {why}")
            bad += 1
    if bad:
        print(f"{bad} line(s) fetch from the internet or run an unpinned image (pipeline-templates actions/check-fetches)")
        return 1
    print("no workflow, action, Dockerfile or Cargo manifest fetches from the internet, and every image is pinned")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
