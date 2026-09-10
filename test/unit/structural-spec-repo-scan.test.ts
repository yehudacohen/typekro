/**
 * Repo scan: which bundled compositions still let a runtime spec value decide
 * build-time structure (issue #190).
 *
 * Every exported composition graph under `src/factories/**\/compositions/` is
 * serialized with `TYPEKRO_STRUCTURAL_SPEC=strict`, which makes the check fire
 * even for a composition that ships with `allowStructuralSpecDependence: true`.
 * The result is compared against a pinned inventory.
 *
 * The inventory may only SHRINK. A new entry means a composition regressed, or
 * a new one shipped with the defect; removing an entry means it was fixed and
 * the pin should be updated in the same commit. Pinning rather than asserting
 * "zero" keeps the scan honest about what is still outstanding instead of
 * quietly tolerating everything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuralSpecDependenceError } from '../../src/core/validation/structural-spec-dependence.js';

const FACTORIES_ROOT = new URL('../../src/factories/', import.meta.url).pathname;

/**
 * Compositions that still depend on a runtime spec value for their structure,
 * keyed by RGD name → the spec paths involved.
 *
 * Each ships with `allowStructuralSpecDependence: true` and an inline comment
 * explaining why the fix is not mechanical. See the PR for issue #190.
 */
const KNOWN_STRUCTURAL_SPEC_DEPENDENCE: Record<string, readonly string[]> = {
  'apisix-bootstrap': ['spec.customValues'],
  'inngest-bootstrap': ['spec.customValues'],
  'web-app-with-processing': ['spec.app.env'],
};

/**
 * Exports this scan cannot serialize for a reason unrelated to issue #190:
 * `rookObjectStorageClaim` declares `supportedModes: ['direct']`, so it has no
 * KRO serialization to check.
 */
const OUT_OF_SCAN_SCOPE = new Set(['rookObjectStorageClaim']);

function compositionModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      compositionModules(full, out);
    } else if (entry.endsWith('.ts') && full.includes('/compositions/')) {
      out.push(full);
    }
  }
  return out;
}

interface GraphLike {
  toYaml: () => string;
  _definition?: unknown;
}

function isGraph(value: unknown): value is GraphLike {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as GraphLike).toYaml === 'function' &&
    (value as GraphLike)._definition !== undefined
  );
}

function isStructuralError(error: unknown): error is StructuralSpecDependenceError {
  return (error as { name?: string } | undefined)?.name === 'StructuralSpecDependenceError';
}

describe('bundled compositions — structural spec dependence inventory', () => {
  // The APISIX bootstrap refuses to emit a definition without concrete
  // credentials. Placeholders keep it in the scan; they never leave this test.
  const CREDENTIAL_PLACEHOLDERS = {
    APISIX_ADMIN_KEY: 'repo-scan-placeholder',
    APISIX_VIEWER_KEY: 'repo-scan-placeholder',
  } as const;

  const previous: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries({
      TYPEKRO_STRUCTURAL_SPEC: 'strict',
      ...CREDENTIAL_PLACEHOLDERS,
    })) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(
    'flags exactly the compositions on the known list, and no others',
    async () => {
      const modules = compositionModules(FACTORIES_ROOT).sort();
      expect(modules.length).toBeGreaterThan(20);

      const flagged = new Map<string, Set<string>>();
      const seenGraphs = new Set<string>();

      for (const file of modules) {
        let loaded: Record<string, unknown>;
        try {
          loaded = (await import(file)) as Record<string, unknown>;
        } catch {
          // A module that will not even load is another test's problem.
          continue;
        }

        for (const [exportName, value] of Object.entries(loaded)) {
          if (!isGraph(value) || OUT_OF_SCAN_SCOPE.has(exportName)) continue;
          seenGraphs.add(exportName);

          try {
            value.toYaml();
          } catch (error) {
            if (!isStructuralError(error)) continue;
            const paths = flagged.get(error.graphName) ?? new Set<string>();
            for (const finding of error.findings) {
              for (const path of finding.specPaths) paths.add(path);
            }
            flagged.set(error.graphName, paths);
          }
        }
      }

      expect(seenGraphs.size).toBeGreaterThan(20);

      const normalize = (entries: [string, Iterable<string>][]): Record<string, string[]> =>
        Object.fromEntries(
          entries
            .map(([name, paths]) => [name, [...paths].sort()] as const)
            .sort(([left], [right]) => left.localeCompare(right))
        );

      expect(normalize([...flagged.entries()])).toEqual(
        normalize(Object.entries(KNOWN_STRUCTURAL_SPEC_DEPENDENCE))
      );
    },
    180_000
  );
});
