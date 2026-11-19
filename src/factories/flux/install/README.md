# Flux install

`makeFluxInstall({ release })` renders a pinned Flux release's install manifests (namespace,
CRDs, RBAC, services, quotas, network policies and controllers) as ordinary TypeKro declarations,
so direct, KRO and Alchemy mode can all apply them. It refuses an unpinned version (`latest`,
`2.7.5` or `v2.7`) and any manifest kind it has no factory for. It applies the Kubernetes 1.33 CRD
schema fix, replaces every controller's tolerations and node selector when those inputs are given,
and reports `ready` once every controller Deployment has all its replicas ready.

**No Flux release is vendored yet.** Downloading Flux's `install.yaml` has not been approved, so
`releases/index.ts` is an empty, clearly marked registry and the tests use a neutral stand-in
release (`test/fixtures/flux/stand-in-release.ts`) shaped like Flux's manifests.

**Adding a pinned release, once the download is approved:** download
`https://github.com/fluxcd/flux2/releases/download/<version>/install.yaml` for an exact version
(for example `v2.7.5`). Parse it into `releases/<version>.ts` exporting a `FluxRelease`
(`{ version, documents }`). Register it in `FLUX_RELEASES`, record the file's sha256 next to it,
and add a test that renders it in direct and KRO mode.
