# Declaration budgets

TypeKro ships one package with many subpath exports (`typekro`, `typekro/traefik`,
`typekro/ory`, ...). A single cap on total declaration bytes
(`scripts/packed-artifact-budgets.json`) cannot tell you which part of the package grew. This
tool measures declaration usage per owner, so each integration has its own small budget, and
core has one of its own.

```bash
bun run build:lib
bun run check:declaration-budgets                     # report, fail on structural problems
bun run check:declaration-budgets --why dist/factories/ory/index.d.ts
bun run check:declaration-budgets --list-unreachable
bun run check:declaration-budgets --write-baseline    # refresh scripts/declaration-baseline.json
bun run check:declaration-budgets --suggest-budgets   # reset budgets to usage + headroom
```

In CI it runs after the build and appends its report to the GitHub step summary.

## How usage is measured

1. Every `types` target in `package.json` `exports` is a public entry.
2. From each entry, the tool walks the emitted `.d.ts` import graph. It follows relative
   `import`/`export ... from`, `export * from`, `import("...")` types, and
   `/// <reference path>`. Package imports such as `arktype` are not followed.
3. Each reachable `.d.ts` file is charged to exactly one owner, using the ordered rules in
   [`scripts/declaration-owners.json`](../declaration-owners.json). The first matching rule
   wins, and globs are relative to `dist/`.
4. An owner's usage is the total size of its reachable files. When an integration
   re-exports a core type, only the re-export line is in the integration's file. The core
   file is counted once, against core.

For each owner the report shows:

| Column | Meaning |
|---|---|
| Raw | Bytes on disk. Budgets use this number. |
| Surface | Raw bytes minus all comments. This is the type surface itself. |
| Doc | Bytes inside `/** ... */` JSDoc blocks. |
| Δ raw, Δ doc | Change against `scripts/declaration-baseline.json`. |
| Budget, Headroom | From `scripts/declaration-budgets.json`. |

## Owners

- **core:** `src/core/**`, `src/utils/**`, `src/shared/**`, `src/compositions/**`, the root
  barrels (`src/index.ts`, `src/aspects.ts`, `src/factories/index.ts`,
  `src/factories/shared.ts`), and the base factories `kubernetes`, `helm`, `flux`, `kro` and
  `simple`. `typekro/containers` lives under `src/core/containers`, so core owns it too.
- **Each integration** owns `src/factories/<name>/**`.
- **`alchemy`, `advanced` and `experimental/planning`** each have their own owner.

## Checks

These checks fail CI now:

- **Unowned file.** A reachable declaration file matches no owner rule.
- **Unresolved import.** A relative import in a declaration file has no emitted target.
- **New cross-owner edge.** One owner's declarations import another non-core owner's
  declarations, and the pair is not in `allowedEdges`. Shared types belong in core. If an
  edge is intended, add it to `allowedEdges` with a `reason`, so a reviewer sees it. Edges
  into core are always allowed. Edges from the root barrels are covered by the next check.
- **Root entry reaches a new owner.** The `typekro` root entry may only reach the owners in
  `rootEntry.allowedOwners`: core plus the integrations `src/factories/index.ts` already
  re-exported when budgets were introduced. **Do not add new integrations to the root
  barrel.** Ship them as a subpath export only. Existing namespace re-exports stay for
  compatibility.
- **Budget configuration.** Every owner needs a budget, every budget needs an owner, and
  the sum of owner budgets must not exceed `globalCapBytes`.

These are report-only for now:

- **Budget overruns.** When `mode` is `"report"`, an owner over budget is shown but does not
  fail. A later change sets `"mode": "enforce"` once the strip-down work has landed.
  `--enforce` previews that locally.
- **Ratchet candidates.** An owner whose headroom is more than twice the standard allowance
  is listed with a suggested lower budget. Lower it in the same PR that shrank the owner.
- **Doc-byte drops.** An owner whose JSDoc bytes fall by more than `docDropFraction` (20%)
  against the baseline is flagged. Confirm that the prose moved somewhere useful and was not
  just deleted.
- **`@internal` declarations.** Declarations tagged `@internal` that appear in reachable
  files are listed. These should be stripped from the published declarations or made
  public.
- **Root barrel imports.** Declaration emit writes `import("../../../index.js").X` for an
  inferred type that the root barrel re-exports. The importing entry then reaches every file
  the root reaches. An explicit type annotation that imports from the defining core module
  avoids this.
- **Unreachable files.** Emitted declarations that no entry reaches. They still ship in the
  package.

## Budgets

`scripts/declaration-budgets.json` sets:

- `globalCapBytes`: a cap on all reachable declarations. The owner budgets must sum to no
  more than this.
- `headroom`: a new budget is usage plus `max(minBytes, fraction × usage)`, rounded up to
  256 bytes. The defaults are 8 KiB and 5%.
- `owners`: the raw-byte budget for each owner.

Raise a budget only with a reason in the PR description. When an owner shrinks, lower its
budget in the same PR. The report lists ratchet candidates.

The baseline in `scripts/declaration-baseline.json` is a committed snapshot, not the base
branch. Refresh it with `--write-baseline` whenever you change budgets, so the next PR's
deltas start from zero.

## Adding a new integration

1. Put the code under `src/factories/<name>/` and add a `"./<name>"` subpath export to
   `package.json`. Do not add it to `src/factories/index.ts` or `src/index.ts`.
2. Add an owner rule to `scripts/declaration-owners.json`:
   `{ "owner": "<name>", "paths": ["factories/<name>/**"] }`.
3. Build, then run `bun run check:declaration-budgets`. Add
   `"<name>": <suggested budget>` to `scripts/declaration-budgets.json`. The suggested budget
   is usage plus `max(8 KiB, 5%)`, rounded up to 256 bytes.
4. If the owner budgets now sum to more than `globalCapBytes`, make room first. Ratchet
   another owner down, or shrink declarations elsewhere. Raising the cap needs a maintainer
   decision.
5. If the new integration needs types from another integration, move those types into core.
   Add an `allowedEdges` entry only when the dependency is part of the design.
6. Keep declarations small. Give inferred composition and factory return types an explicit
   annotation that imports from core, so the entry does not pull in the root barrel.

## JSDoc policy

The strip-down that follows this tool trims JSDoc in published declarations:

- **In the `.d.ts`:** a 1 to 3 line summary, plus `@see docs/...` for anything longer.
  Keep `@example` short.
- **Longer rationale:** design notes and history move into `//` comments in the source.
  TypeScript does not emit `//` comments into declarations.

The doc-byte drop check makes those removals visible in review.
