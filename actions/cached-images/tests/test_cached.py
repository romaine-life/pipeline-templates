"""python3 -m unittest discover actions/cached-images/tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cached  # noqa: E402

D = "@sha256:" + "b" * 64

# As Artifact Keeper's /api/v1/repositories lists them (fields trimmed).
ITEMS = [
    {"key": "dockerhub", "format": "docker", "repo_type": "remote", "upstream_url": "https://registry-1.docker.io"},
    {"key": "ghcr", "format": "docker", "repo_type": "remote", "upstream_url": "https://ghcr.io"},
    {"key": "quay", "format": "docker", "repo_type": "remote", "upstream_url": "https://quay.io/"},
    {"key": "npm", "format": "npm", "repo_type": "remote", "upstream_url": "https://registry.npmjs.org"},
    {"key": "vs-layouts", "format": "generic", "repo_type": "hosted", "upstream_url": None},
]


class CachedImages(unittest.TestCase):
    by_registry = cached.caches(ITEMS)

    def test_docker_caches_by_registry_name(self):
        self.assertEqual(self.by_registry, {"docker.io": "dockerhub", "ghcr.io": "ghcr", "quay.io": "quay"})

    def test_names_through_the_cache(self):
        for ref, want in [
            (f"binwiederhier/ntfy:v2.31.1{D}", f"artifacts.home.romaine.life/dockerhub/binwiederhier/ntfy:v2.31.1{D}"),
            (f"redis:8.6.4-alpine{D}", f"artifacts.home.romaine.life/dockerhub/library/redis:8.6.4-alpine{D}"),
            (f"docker.io/qmcgaw/gluetun:v3.41.3{D}", f"artifacts.home.romaine.life/dockerhub/qmcgaw/gluetun:v3.41.3{D}"),
            (f"ghcr.io/linuxserver/qbittorrent:5.3.0{D}", f"artifacts.home.romaine.life/ghcr/linuxserver/qbittorrent:5.3.0{D}"),
            (f"quay.io/oauth2-proxy/oauth2-proxy{D}", f"artifacts.home.romaine.life/quay/oauth2-proxy/oauth2-proxy{D}"),
            (f"forgejo.romaine.life/nelsong6/avatars:v0.1.3{D}", f"forgejo.romaine.life/nelsong6/avatars:v0.1.3{D}"),
        ]:
            self.assertEqual(cached.cached(ref, self.by_registry), want)

    def test_refuses_an_unpinned_image(self):
        with self.assertRaisesRegex(ValueError, "by digest"):
            cached.cached("binwiederhier/ntfy:v2.31.1", self.by_registry)

    def test_refuses_a_registry_without_a_cache(self):
        with self.assertRaisesRegex(ValueError, "no cache for lscr.io"):
            cached.cached(f"lscr.io/linuxserver/qbittorrent:5.3.0{D}", self.by_registry)


if __name__ == "__main__":
    unittest.main()
