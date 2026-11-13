#!/usr/bin/env python3
"""cached.py <variable>...: names each image in those variables through Artifact Keeper.

A manifest names an image as its registry publishes it (the home cluster's node reaches the
registry through Artifact Keeper by its mirrors); a CI job that runs the same image pulls it
from Artifact Keeper by name instead, `artifacts.home.romaine.life/<cache>/<path>`. This
rewrites each named environment variable to that name, in $GITHUB_ENV, from Artifact
Keeper's own list of its Docker caches, so a cache added there is used here with no change.

An image must be named by digest; our own forgejo.romaine.life images are left as they are.
"""

import json
import os
import re
import sys
import urllib.request
from urllib.parse import urlparse

HOST = "artifacts.home.romaine.life"
OWN = "forgejo.romaine.life"
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
# Docker Hub's API answers at registry-1.docker.io; images name it docker.io.
REGISTRY_NAMES = {"registry-1.docker.io": "docker.io"}


def caches(items):
    """Registry host -> cache key, from Artifact Keeper's repositories."""
    out = {}
    for r in items:
        if r.get("format") == "docker" and r.get("repo_type") == "remote" and r.get("upstream_url"):
            host = urlparse(r["upstream_url"]).hostname
            out[REGISTRY_NAMES.get(host, host)] = r["key"]
    return out


def split(ref):
    """(registry, path and tag/digest) of an image name, as Docker reads it."""
    first, _, rest = ref.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        return first, rest
    return "docker.io", ref if rest else "library/" + ref


def cached(ref, by_registry):
    if not DIGEST.search(ref):
        raise ValueError(f"image {ref}: name it by digest (<image>:<tag>@sha256:<digest>)")
    registry, path = split(ref)
    if registry in (OWN, HOST):
        return ref
    if registry not in by_registry:
        raise ValueError(f"image {ref}: Artifact Keeper has no cache for {registry}; add one in artifact-keeper's k8s/caches.txt")
    return f"{HOST}/{by_registry[registry]}/{path}"


def repositories():
    items, page = [], 1
    while True:
        with urllib.request.urlopen(f"https://{HOST}/api/v1/repositories?per_page=100&page={page}", timeout=30) as r:
            body = json.load(r)
        items += body["items"]
        if page >= body["pagination"]["total_pages"]:
            return items
        page += 1


def main(argv):
    names = argv[1:]
    if not names:
        print("::error::cached-images: name the variables that hold images")
        return 1
    by_registry = caches(repositories())
    lines = []
    for name in names:
        ref = os.environ.get(name, "")
        if not ref:
            print(f"::error::cached-images: {name} is empty or unset")
            return 1
        try:
            lines.append(f"{name}={cached(ref, by_registry)}")
        except ValueError as e:
            print(f"::error::cached-images: {name}: {e}")
            return 1
        print(f"{name}: {ref} -> {lines[-1].split('=', 1)[1]}")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
        env.write("".join(line + "\n" for line in lines))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
