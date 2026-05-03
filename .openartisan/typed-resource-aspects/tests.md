# TESTS Artifact Mirror

This compatibility mirror exists only for Open Artisan's legacy artifact hash path.

The actual TESTS artifacts under review are real runnable files:

- `/Users/yehudac/workspace/typekro/test/unit/aspects-types.test.ts`
- `/Users/yehudac/workspace/typekro/test/unit/aspects.test.ts`

The reviewed files cover typed resource aspects across public helper exports, target groups,
selectors, cardinality, spec-derived override operations, direct/Kro render paths,
Kro-safety failures, diagnostics, boundaries, and idempotence.

Targeted verification commands currently fail at the expected pre-implementation export boundary:

- `bun test test/unit/aspects-types.test.ts --timeout 10000`
- `bun test test/unit/aspects.test.ts --timeout 10000`

Failure observed in both files:

```text
SyntaxError: Export named 'allResources' not found in module '/Users/yehudac/workspace/typekro/src/index.ts'.
```
