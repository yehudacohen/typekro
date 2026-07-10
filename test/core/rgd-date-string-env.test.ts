/**
 * Regression: a string env value that LOOKS like a YAML timestamp (e.g. "2026-06-01") must survive the
 * RGD serialize→apply round-trip as a STRING, not be coerced to a Date object.
 *
 * `serializeResourceGraphToYaml` dumps with js-yaml JSON_SCHEMA (no timestamp type → the scalar is
 * emitted UNQUOTED). The alchemy deploy path then `yaml.load`s that RGD back into the object it applies;
 * with js-yaml's DEFAULT (timestamp-aware) schema the unquoted scalar coerced to a `Date`, so the applied
 * RGD carried an object where KRO's schema requires a string → `GraphAccepted=False` → the graph never
 * reconciled. The load must use JSON_SCHEMA to match the dump. Revert-proven: without the fix the value
 * comes back as a Date.
 */
import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition, simple, withEnvVars } from '../../src/index.js';

const findEnvValue = (decls: any[], name: string): unknown => {
  for (const d of decls) {
    const res = d?.props?.resource ?? d?.resource;
    const resources = res?.spec?.resources;
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      const containers = r?.template?.spec?.template?.spec?.containers ?? [];
      for (const c of containers) {
        const hit = (c?.env ?? []).find((e: any) => e?.name === name);
        if (hit) return hit.value;
      }
    }
  }
  return undefined;
};

describe('RGD date-shaped env value round-trips as a string (alchemy deploy path)', () => {
  it('keeps GCP_PARTITIONS_START_DATE a string, not a Date object', async () => {
    const comp = kubernetesComposition(
      { name: 'cs', kind: 'CS', spec: type({ name: 'string' }), status: type({ ready: 'boolean' }) },
      (spec) => {
        const d = simple.Deployment({ name: spec.name, image: 'nginx', id: 'dep' });
        return { ready: d.status.readyReplicas >= 1 };
      }
    );
    const f = await comp.factory('kro', {
      namespace: 'ns',
      waitForReady: false,
      aspects: [withEnvVars({ GCP_PARTITIONS_START_DATE: '2026-06-01', GCP_OTHER: 'prod' })],
    });
    const decls = (await f.toAlchemyResources({ name: 'demo', namespace: 'ns' } as any)) as any[];

    const value = findEnvValue(decls, 'GCP_PARTITIONS_START_DATE');
    expect(value).toBe('2026-06-01');
    expect(typeof value).toBe('string');
    expect(value instanceof Date).toBe(false);
    expect(findEnvValue(decls, 'GCP_OTHER')).toBe('prod');
  });
});
