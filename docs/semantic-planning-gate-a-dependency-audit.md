# Semantic Planning Gate A Dependency Audit

**Baseline:** TypeKro v0.28.1 (`744ba08`)
**Audit date:** 2026-07-20
**Runtime:** Bun 1.3.13

## Commands

```sh
bun audit
bun pm why node-fetch
bun pm why @kubernetes/client-node
bun run check:effect-cohort
bun run test:packed-imports
```

## Findings

`bun audit` reports 66 advisories in the locked dependency graph: 1 critical, 20 high,
38 moderate, and 7 low. The important chains for TypeKro are:

- `angular-expressions` is a direct dependency with a critical advisory.
- `js-yaml` is a direct dependency, and is also pulled through
  `@kubernetes/client-node`, with moderate and high advisories.
- `@kubernetes/client-node` pulls vulnerable versions of `form-data`, `ws`, and
  `ip-address`; it also pulls the deprecated `node-fetch@2.7.0` chain.
- `mermaid` is a direct documentation dependency with several browser-side
  sanitization advisories.
- The remaining findings are predominantly development, documentation, and
  Alchemy transitive chains (`vite`, `rollup`, `esbuild`, `dompurify`, glob
  packages, XML packages, and related tooling).

Gate A makes public TypeKro imports quiet and defers loading the Kubernetes SDK
until Kubernetes functionality is used. That removes the import-time deprecation
warning and cost, but it does not remediate these runtime dependency findings.

Dependency upgrades should be handled as a separate compatibility-tested stream.
This architecture change intentionally does not mutate the lockfile or accept
breaking transitive upgrades implicitly.

## Packaging Evidence

The packed-artifact gate builds and packs the publishable package, validates every declared
JavaScript and declaration export, imports all exports in fresh Node and Bun processes, rejects
import-time output, and enforces the machine-readable budgets in
`scripts/packed-artifact-budgets.json`.

The 2026-07-22 baseline is:

| Metric | Measured | Enforced ceiling |
|---|---:|---:|
| Export entries | 29 | All declared entries must resolve and import |
| Tarball | 2,040,000 bytes | 4,000,000 bytes |
| Unpacked package | 9,937,727 bytes | 15,000,000 bytes |
| TypeScript declarations | 1,840,561 bytes | 2,500,000 bytes |
| Files | 2,124 | 3,000 |
| Node cold process/import | 880 ms | 5,000 ms |
| Bun cold process/import | 671 ms | 5,000 ms |

Cold-import ceilings include process startup and intentionally leave substantial CI-runner
headroom. The measured values remain visible in the command's JSON evidence so maintainers can
tighten or deliberately revise budgets rather than allowing silent growth.
