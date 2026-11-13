"""python3 -m unittest discover actions/check-image-digests/tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check  # noqa: E402

D = "@sha256:" + "a" * 64

RENDERED = f"""\
---
# Source: app/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: seed
          image: "docker.io/library/busybox:1.37.0{D}"
      containers:
      - image: quay.io/openbao/openbao:2.7.1
        name: bao
      - name: gate
        image: 'quay.io/oauth2-proxy/oauth2-proxy:v7.15.5{D}'  # pinned
---
apiVersion: v1
kind: ConfigMap
data:
  compose.yml: |
    services:
      app:
        image: nginx:latest
  other: plain
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
spec:
  versions:
    - schema:
        openAPIV3Schema:
          properties:
            image:
              description: >-
                image: the container's image, e.g. image: nginx:latest
              type: string
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
spec:
  provider:
    kubernetes:
      envoyDeployment:
        container:
          image: docker.io/envoyproxy/envoy:distroless-v1.37.1
"""


class CheckImageDigests(unittest.TestCase):
    def test_names_every_image_outside_crds_and_block_scalars(self):
        found = [ref for _, ref in check.images(RENDERED)]
        self.assertEqual(found, [
            f"docker.io/library/busybox:1.37.0{D}",
            "quay.io/openbao/openbao:2.7.1",
            f"quay.io/oauth2-proxy/oauth2-proxy:v7.15.5{D}",
            "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie",
            "docker.io/envoyproxy/envoy:distroless-v1.37.1",
        ])

    def run_main(self, files):
        with tempfile.TemporaryDirectory() as d:
            for name, text in files.items():
                (Path(d) / name).parent.mkdir(parents=True, exist_ok=True)
                (Path(d) / name).write_text(text, encoding="utf-8")
            return check.main(["check", d])

    def test_fails_an_image_without_a_digest(self):
        self.assertEqual(self.run_main({"a/rendered.yaml": RENDERED}), 1)

    def test_passes_when_every_image_has_a_digest(self):
        self.assertEqual(self.run_main({"rendered.yml": f"kind: Pod\nspec:\n  containers:\n    - image: x/y:1{D}\n"}), 0)

    def test_a_tag_after_the_digest_is_not_a_digest(self):
        self.assertEqual(self.run_main({"r.yaml": f"kind: Pod\nspec:\n  containers:\n    - image: x/y{D}:1\n"}), 1)

    def test_nothing_rendered_fails(self):
        self.assertEqual(self.run_main({"r.yaml": "kind: Service\n"}), 1)

    def test_a_missing_path_fails(self):
        self.assertEqual(check.main(["check", "/nonexistent/rendered.yaml"]), 1)


if __name__ == "__main__":
    unittest.main()
