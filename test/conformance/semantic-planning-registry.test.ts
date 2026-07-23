import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RegistryEntry {
  readonly id: string;
  readonly evidence: readonly string[];
}

interface ConformanceRegistry {
  readonly version: number;
  readonly baseline: { readonly release: string; readonly commit: string };
  readonly qualityGates: readonly RegistryEntry[];
  readonly fixtures: readonly RegistryEntry[];
}

const workspace = resolve(import.meta.dir, '../..');
const registry = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'semantic-planning.registry.json'), 'utf8')
) as ConformanceRegistry;

const mandatoryFixtureIds = [
  'ordered-aspects',
  'nested-defaults',
  'conditional-readiness',
  'singleton-lifecycle',
  'kro-representation-requirements',
  'namespace-artifact-roles',
  'stable-and-preview-identities',
  'declared-input-manifests',
  'persisted-and-hydrated-status',
  'desired-canonicalizers',
  'external-references',
  'runtime-closures',
  'portable-and-raw-expressions',
  'sensitive-values',
  'container-requirements',
  'harbor-provider-boundary',
  'omitted-versus-empty',
  'current-generation-readiness',
  'yaml-unresolved-bindings',
  'natural-typescript-analyzer-corpus',
  'third-party-target-parity',
  'artifact-json-roundtrip',
  'target-host-apply-matrix',
  'effect-runtime-boundary',
  'effect-installed-cohort',
] as const;

describe('semantic planning conformance registry', () => {
  it('pins the v0.28.1 baseline and lists every mandatory fixture exactly once', () => {
    expect(registry.version).toBe(1);
    expect(registry.baseline).toEqual({ release: '0.28.1', commit: '744ba08' });
    expect(registry.fixtures.map((fixture) => fixture.id).sort()).toEqual(
      [...mandatoryFixtureIds].sort()
    );
  });

  it('links every fixture and quality gate to checked-in evidence', () => {
    for (const entry of [...registry.qualityGates, ...registry.fixtures]) {
      expect(entry.evidence.length, `${entry.id} has no evidence`).toBeGreaterThan(0);
      for (const evidence of entry.evidence) {
        expect(existsSync(resolve(workspace, evidence)), `${entry.id}: missing ${evidence}`).toBe(
          true
        );
      }
    }
  });
});
