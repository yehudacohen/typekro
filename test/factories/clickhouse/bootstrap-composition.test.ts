import { describe, expect, it } from 'bun:test';
import {
  clickhouseHelmRepositoryBootstrap,
  clickhouseOperatorBootstrap,
} from '../../../src/factories/clickhouse/index.js';
import {
  ClickHouseOperatorBootstrapConfigSchema,
  ClickHouseOperatorBootstrapStatusSchema,
} from '../../../src/factories/clickhouse/types.js';

// Test decision: use the clickhouse package barrel for bootstrap behavior so
// this suite catches missing public wiring, not only a helper-only composition
// file — `typekro/clickhouse` is the user-facing seam (mirrors the Dagster
// bootstrap suite).
describe('ClickHouse operator bootstrap composition', () => {
  it('Accept valid bootstrap config through the config schema', () => {
    const result = ClickHouseOperatorBootstrapConfigSchema({
      name: 'clickhouse-operator',
      namespace: 'clickhouse-system',
      version: '0.27.1',
      metrics: { enabled: true },
      crdHook: { enabled: true },
      resources: { requests: { cpu: '100m', memory: '128Mi' } },
      customValues: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Expose bootstrap status fields derived from the HelmRelease', () => {
    const result = ClickHouseOperatorBootstrapStatusSchema({
      ready: true,
      phase: 'Ready',
      version: '0.27.1',
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Generate ResourceGraphDefinition YAML with the official chart coordinates', () => {
    const yaml = clickhouseOperatorBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: clickhouse-operator-bootstrap');
    expect(yaml).toContain('clickhouseOperatorHelmRelease');
    // The owned workload Namespace is HOISTED out of the RGD graph (emitted as a
    // retained resource by the factory instead), so it is no longer a graph child.
    expect(yaml).not.toContain('clickhouseNamespace');
    expect(yaml).not.toContain('kind: Namespace');
    expect(yaml).toContain('kind: HelmRelease');
    // Official Altinity chart + default version (the default surfaces in the
    // has()-guarded version fallback).
    expect(yaml).toContain('chart: altinity-clickhouse-operator');
    expect(yaml).toContain('0.27.1');
    // The HelmRepository is a shared cluster-level singleton referenced via
    // externalRef (not owned per-instance), so repeated installs don't
    // collide on KRO's per-instance ApplySet ownership of it.
    expect(yaml).toContain('externalRef');
    expect(yaml).toContain('kind: ClickHouseHelmRepository');
    // sourceRef still points the HelmRelease at the (shared) HelmRepository.
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('name: altinity');
    expect(yaml).toContain('driftDetection:');
    expect(yaml).toContain('mode: enabled');
  });

  it('Merge schema customValues into the KRO-serialized HelmRelease values at runtime', () => {
    // The graph-mode leak the review flagged: `customValues` used to be
    // accepted by the schema but silently dropped from the serialized
    // HelmRelease values. It now routes through the graph-aware runtime
    // values merge, so an instance's customValues map (e.g. a nodeSelector
    // override) lands in the rendered values at reconcile time.
    const yaml = clickhouseOperatorBootstrap.toYaml();
    const helmReleaseDoc = yaml.slice(yaml.indexOf('id: clickhouseOperatorHelmRelease'));
    const valuesLine = helmReleaseDoc
      .split('\n')
      .find((line) => line.trimStart().startsWith('values:'));

    expect(valuesLine).toBeDefined();
    // customValues participates in the runtime merge...
    expect(valuesLine).toContain('schema.spec.customValues');
    expect(valuesLine).toContain('.merge(');
    // ...alongside the typed mapped fields (still present, overridable).
    expect(valuesLine).toContain('schema.spec.metrics');
    expect(valuesLine).toContain('schema.spec.crdHook');
    expect(valuesLine).toContain('schema.spec.resources');
    // No internal marker garbage in the rendered values.
    expect(helmReleaseDoc).not.toContain('__typekroSchemaKey');
  });

  it('Derive ready/phase status from the HelmRelease Ready condition', () => {
    const yaml = clickhouseOperatorBootstrap.toYaml();

    expect(yaml).toContain('ready: ${clickhouseOperatorHelmRelease.status.conditions');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
  });

  it('Own the shared HelmRepository in the singleton composition', () => {
    const repoYaml = clickhouseHelmRepositoryBootstrap.toYaml();

    expect(repoYaml).toContain('kind: ResourceGraphDefinition');
    expect(repoYaml).toContain('kind: ClickHouseHelmRepository');
    expect(repoYaml).toContain('kind: HelmRepository');
    expect(repoYaml).toContain('url: ${schema.spec.url}');
  });

  it('Emit the HelmRepository singleton owner in the GitOps toYaml bundle', () => {
    // The bootstrap RGD only externalRefs the shared ClickHouseHelmRepository
    // singleton; toYaml() must also emit the singleton owner RGD (deps-first)
    // or the externalRef dangles.
    const rgdBundle = clickhouseOperatorBootstrap.toYaml();
    const rgdDocs = rgdBundle.split(/^---$/m).map((doc) => doc.trim());
    expect(rgdDocs).toHaveLength(2);
    expect(rgdBundle).toContain('name: clickhouse-helm-repository');
    expect(rgdBundle).toContain('name: clickhouse-operator-bootstrap');
    // Owner RGD before the consuming RGD (deps-first apply order).
    expect(rgdBundle.indexOf('name: clickhouse-helm-repository')).toBeLessThan(
      rgdBundle.indexOf('name: clickhouse-operator-bootstrap')
    );

    const instanceBundle = clickhouseOperatorBootstrap
      .factory('kro', { namespace: 'typekro-system' })
      .toYaml({ name: 'clickhouse-operator' } as never);
    expect(instanceBundle).toContain('kind: ClickHouseHelmRepository');
    expect(instanceBundle).toContain('url: https://helm.altinity.com');
    expect(instanceBundle).toContain('kind: ClickHouseOperatorBootstrap');
  });

  it('Generate direct-mode YAML with the concrete repository and release', async () => {
    const factory = clickhouseOperatorBootstrap.factory('direct', {
      namespace: 'typekro-clickhouse-test',
    });
    const yaml = await factory.toYaml({
      name: 'clickhouse-operator',
      namespace: 'clickhouse-op',
      version: '0.27.1',
      metrics: { enabled: true },
    });

    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: HelmRelease');
    // The shared HelmRepository is deployed by the singleton owner (not part
    // of the per-instance direct bundle); the release references it by
    // sourceRef. The concrete URL is asserted on the kro instance bundle.
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('name: altinity');
    expect(yaml).toContain('altinity-clickhouse-operator');
    expect(yaml).toContain('0.27.1');
    expect(yaml).not.toContain('undefined');
    expect(yaml).not.toContain('[object Object]');
  });
});
