# Flux install

`makeFluxInstall({ release })` renders a pinned Flux release's install manifests (namespace,
CRDs, RBAC, services, quotas, network policies and controllers) as ordinary TypeKro declarations,
so direct, KRO and Alchemy mode can all apply them. It refuses an unpinned version (`latest`,
`2.7.5` or `v2.7`) and any manifest kind it has no factory for. It applies the Kubernetes 1.33 CRD
schema fix, replaces every controller's tolerations and node selector when those inputs are given,
and reports `ready` once every controller Deployment has all its replicas ready.

`fluxInstallForVersion('v2.7.5')` builds it for a release in `FLUX_RELEASES`.

## Pinned releases

| Version | `install.yaml` sha256 |
| --- | --- |
| `v2.7.5` | `c346a4714b8e3a3bd73bad36d48f3d690df8c7707646633a70851332253d4dbf` |

Each sha256 matches the digest GitHub publishes for the release asset.

## Adding a pinned release

1. Download `https://github.com/fluxcd/flux2/releases/download/<version>/install.yaml` for an
   exact version, and check its sha256 against the asset digest on the release.
2. Run `bun run scripts/vendor-flux-release.ts <version> <path/to/install.yaml>`. It parses the
   file as plain YAML data and writes `releases/<version>.ts` with the documents and the sha256.
3. Format it with `biome format --write`, register it in `releases/index.ts`, add a row above,
   and add a test like `test/factories/flux/flux-install-release.test.ts`.
