#!/usr/bin/env python3
"""check.py <file or directory>...: fails when a rendered manifest runs an image not named by digest.

The home cluster pulls every image through Artifact Keeper by the node's registry mirrors,
and a manifest names each one `<image>:<tag>@sha256:<digest>`, so a restart brings up the
image that ran before and a change of image is a commit (FORGEJO-29, HC-1).

This reads rendered manifests (helm template, kustomize build) and names every `image:` and
`imageName:` (CloudNativePG's Cluster) whose value doesn't end in a digest. A
CustomResourceDefinition's documents are skipped (their schemas name fields, not images), as
are block scalars (a ConfigMap's embedded files). Standard library only, no network.
"""

import re
import sys
from pathlib import Path

DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
SEPARATOR = re.compile(r"^---(\s.*)?$")
CRD = re.compile(r"^kind:\s*['\"]?CustomResourceDefinition['\"]?\s*(#.*)?$")
KEY = re.compile(r"^(?P<indent>\s*(?:-\s+)*)(?P<key>image|imageName):(?:\s+(?P<value>.*?))?\s*$")
BLOCK = re.compile(r"^(?P<indent>\s*(?:-\s+)*)[^#\s][^#]*?:\s*[|>][-+0-9]*\s*(#.*)?$")


def documents(text):
    """Each YAML document as a list of (line number, line)."""
    doc = []
    for number, line in enumerate(text.splitlines(), 1):
        if SEPARATOR.match(line):
            yield doc
            doc = []
        else:
            doc.append((number, line))
    yield doc


def scalar(value):
    """The plain value of a one-line scalar, or None when it isn't one."""
    value = re.sub(r"\s+#.*$", "", value or "").strip()
    if not value or value[0] in "|>{[&*!#" or value in ("~", "null"):
        return None
    if value[0] in "'\"" and value[-1:] == value[0]:
        value = value[1:-1]
    return value or None


def images(text):
    """(line number, image) for each image a rendered manifest runs."""
    for doc in documents(text):
        if any(CRD.match(line) for _, line in doc):
            continue
        block = None  # the indentation a block scalar's lines are deeper than
        for number, line in doc:
            if block is not None:
                if not line.strip() or len(line) - len(line.lstrip()) > block:
                    continue
                block = None
            if line.lstrip().startswith("#"):
                continue
            m = BLOCK.match(line)
            if m:
                block = len(m.group("indent"))
                continue
            m = KEY.match(line)
            if m:
                ref = scalar(m.group("value"))
                if ref:
                    yield number, ref


def files(paths):
    for p in map(Path, paths):
        if p.is_dir():
            yield from sorted(f for f in p.rglob("*") if f.is_file() and f.suffix in (".yaml", ".yml"))
        elif p.is_file():
            yield p
        else:
            raise FileNotFoundError(f"{p}: no such file or directory")


def main(argv):
    if len(argv) < 2:
        print("::error::check-image-digests: name the rendered manifests to check")
        return 1
    try:
        found = list(files(argv[1:]))
    except FileNotFoundError as e:
        print(f"::error::check-image-digests: {e}")
        return 1
    seen = bad = 0
    for path in found:
        for number, ref in images(path.read_text(encoding="utf-8", errors="replace")):
            seen += 1
            if not DIGEST.search(ref):
                print(f"::error file={path.as_posix()},line={number}::image {ref}: name it by digest "
                      "(<image>:<tag>@sha256:<digest>), so it changes only in a commit")
                bad += 1
    if not seen:
        print("::error::check-image-digests: the manifests run no image; check what was rendered")
        return 1
    if bad:
        print(f"{bad} of {seen} image(s) not named by digest (pipeline-templates actions/check-image-digests)")
        return 1
    print(f"all {seen} image(s) named by digest")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
