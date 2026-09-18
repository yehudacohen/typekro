/**
 * The RGD name readiness LOOKS UP must be the RGD name the factory EMITS — for every shipped
 * composition, not just the synthetic `web-app` / `WebApp` fixtures.
 *
 * WHY THIS EXISTS. `waitForKroInstanceReady` reads the ResourceGraphDefinition to learn which custom
 * status fields an instance is expected to project. That lookup is now STRICT about a 404: a missing
 * RGD no longer falls through to "this instance has no custom status" (which declared an
 * ACTIVE/synced instance ready without validating anything). Strictness is only safe if the name
 * being looked up is genuinely the name that was applied — otherwise every deploy of a mismatched
 * composition would wait out its whole timeout.
 *
 * Today both sides read the SAME stored field, `KroResourceFactoryImpl.rgdName`, derived once in the
 * constructor via `convertToKubernetesName(definition.name)`; the readiness path never re-derives
 * from `kind` or `apiVersion`. This test pins that property against the real shipped set, so a future
 * refactor that re-derives the lookup name cannot pass. It would break hardest on compositions whose
 * name and kind disagree beyond simple kebab-casing — `apisix-helm-repository`/`APISixHelmRepository`,
 * `opentelemetry-helm-repository`/`OpenTelemetryHelmRepository`,
 * `rook-ceph-operator-bootstrap`/`RookCephOperatorBootstrap` — all of which the synthetic fixtures in
 * `kro-readiness.test.ts` (`web-app` / `WebApp`) would happily keep passing.
 *
 * DETERMINISM. The walk runs exactly once, at module load, and every case reads the result
 * synchronously — the same pattern (and for the same reasons) as `literal-status-repo-scan.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const FACTORIES_DIR = join(import.meta.dir, '..', '..', 'src', 'factories');

/**
 * Compositions that cannot be serialized in KRO mode at all, and why. Recorded rather than skipped:
 * a composition dropping out of the scan should be a visible decision, not a silent gap.
 */
const NOT_KRO_SERIALIZABLE: Readonly<Record<string, string>> = {
  'rook::rookObjectStorageClaim': 'direct mode only — declares supportedModes: [direct]',
};

/** Credentials some bootstraps demand before their composition function will run. Placeholders. */
const SCAN_ENV: Readonly<Record<string, string>> = {
  APISIX_ADMIN_KEY: 'rgd-name-scan-placeholder',
  APISIX_VIEWER_KEY: 'rgd-name-scan-placeholder',
};

interface NameCheck {
  /** What `KroResourceFactoryImpl.rgdName` holds — the string readiness looks up. */
  readonly lookupName: unknown;
  /**
   * `metadata.name` of EVERY ResourceGraphDefinition the same factory emits. A composition can emit
   * more than one — a bootstrap also emits the RGDs it depends on (e.g. `apisix-bootstrap` emits
   * `apisix-helm-repository` alongside itself). The property readiness depends on is that the name
   * it looks up is among the RGDs that were actually applied.
   */
  readonly emittedNames: string[];
}

interface ScanResult {
  readonly checked: Record<string, NameCheck>;
  readonly unscannable: Record<string, string>;
  readonly moduleCount: number;
}

/** Every `src/factories/<name>` entry point that might export compositions. */
function compositionModules(): { factory: string; path: string }[] {
  const modules: { factory: string; path: string }[] = [];
  for (const factory of readdirSync(FACTORIES_DIR).sort()) {
    for (const relative of [join('compositions', 'index.ts'), 'index.ts']) {
      const path = join(FACTORIES_DIR, factory, relative);
      try {
        if (statSync(path).isFile()) {
          modules.push({ factory, path });
          break;
        }
      } catch {
        // Not every factory ships compositions.
      }
    }
  }
  return modules;
}

/** The names of every ResourceGraphDefinition document in a multi-document YAML string. */
function resourceGraphDefinitionNames(yaml: string): string[] {
  const names: string[] = [];
  for (const raw of yaml.split(/^---$/m)) {
    if (!raw.trim()) continue;
    const doc = load(raw) as { kind?: unknown; metadata?: { name?: unknown } } | undefined;
    if (doc?.kind === 'ResourceGraphDefinition' && typeof doc.metadata?.name === 'string') {
      names.push(doc.metadata.name);
    }
  }
  return names;
}

async function scanBundledCompositions(): Promise<ScanResult> {
  const restore: [string, string | undefined][] = Object.entries(SCAN_ENV).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = previous ?? value;
    return [key, previous];
  });

  const checked: Record<string, NameCheck> = {};
  const unscannable: Record<string, string> = {};
  const modules = compositionModules();

  try {
    for (const { factory, path } of modules) {
      const module = (await import(path)) as Record<string, unknown>;

      for (const [exportName, value] of Object.entries(module)) {
        const graph = value as
          | { factory?: (mode: string, options?: unknown) => { toYaml: () => string } }
          | undefined;
        if (!graph || typeof graph.factory !== 'function') continue;

        const key = `${factory}::${exportName}`;
        try {
          const kroFactory = graph.factory('kro') as { rgdName?: unknown; toYaml: () => string };
          checked[key] = {
            lookupName: kroFactory.rgdName,
            emittedNames: resourceGraphDefinitionNames(kroFactory.toYaml()),
          };
        } catch (error) {
          unscannable[key] = (error as { message?: string })?.message ?? String(error);
        }
      }
    }
  } finally {
    for (const [key, previous] of restore) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }

  return { checked, unscannable, moduleCount: modules.length };
}

const scan: ScanResult = await scanBundledCompositions();

describe('shipped compositions: readiness RGD lookup name == emitted RGD name', () => {
  it('emits the RGD that readiness will look up, for every shipped composition', () => {
    const mismatched = Object.entries(scan.checked)
      .filter(
        ([, { lookupName, emittedNames }]) =>
          typeof lookupName !== 'string' || !emittedNames.includes(lookupName)
      )
      .map(
        ([key, { lookupName, emittedNames }]) =>
          `${key}: looks up ${String(lookupName)}, emits [${emittedNames.join(', ')}]`
      );

    // A mismatch here means a strict 404 in the readiness RGD lookup would wait out the whole
    // deployment timeout for that composition. Fix the derivation, do not loosen the lookup.
    expect(mismatched).toEqual([]);
  });

  it('resolves a non-empty, DNS-safe lookup name', () => {
    const dnsName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const bad = Object.entries(scan.checked)
      .filter(
        ([, { lookupName }]) => typeof lookupName !== 'string' || !dnsName.test(lookupName)
      )
      .map(([key, { lookupName }]) => `${key}: ${String(lookupName)}`);
    expect(bad).toEqual([]);
  });

  it('emits at least one RGD per scanned composition', () => {
    // Guards the YAML extraction: a parser change that found no RGD documents would make the
    // match assertion above vacuous in the other direction.
    const empty = Object.entries(scan.checked)
      .filter(([, { emittedNames }]) => emittedNames.length === 0)
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it('records every composition that cannot be scanned in KRO mode', () => {
    expect(Object.keys(scan.unscannable).sort()).toEqual(Object.keys(NOT_KRO_SERIALIZABLE).sort());
  });

  it('scans a meaningful number of compositions', () => {
    // Guards the walk itself: an import path change that silently found nothing would otherwise
    // pass every assertion above vacuously.
    expect(scan.moduleCount).toBeGreaterThan(15);
    expect(Object.keys(scan.checked).length).toBeGreaterThan(30);
  });
});
