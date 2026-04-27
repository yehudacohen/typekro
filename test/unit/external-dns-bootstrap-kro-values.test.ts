import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { externalDnsBootstrap } from '../../src/factories/external-dns/compositions/external-dns-bootstrap.js';

describe('externalDnsBootstrap KRO Helm values serialization', () => {
  it('emits dynamic Helm values as one spec.values CEL object', () => {
    const yaml = externalDnsBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('values: "${');
    expect(yaml).toContain('schema.spec.provider');
    expect(yaml).toContain('schema.spec.domainFilters');
    expect(yaml).toContain('AWS_SESSION_TOKEN');
    expect(yaml).toContain('session-token');
    expect(yaml).not.toContain('spec.values.domainFilters');
    expect(() => externalDnsBootstrap.factory('kro')).not.toThrow();
  });

  it('keeps nested composition values dynamic without hardcoding readiness', () => {
    const Spec = type({ domain: 'string' });
    const Status = type({ ready: 'boolean' });

    const composition = kubernetesComposition(
      {
        name: 'external-dns-nested-values',
        apiVersion: 'example.com/v1alpha1',
        kind: 'ExternalDnsNestedValues',
        spec: Spec,
        status: Status,
      },
      (spec) => {
        const externalDns = externalDnsBootstrap({
          name: 'external-dns',
          namespace: 'external-dns',
          provider: 'aws',
          domainFilters: [spec.domain],
          policy: 'sync',
        });

        return { ready: externalDns.status.ready };
      }
    );

    const yaml = composition.toYaml();

    expect(yaml).toContain('externalDnsBootstrap1ExternalDnsHelmRelease');
    expect(yaml).toContain('values: "${{');
    expect(yaml).toContain('\\"domainFilters\\": [schema.spec.domain]');
    expect(yaml).toContain('externalDnsBootstrap1ExternalDnsHelmRelease.status.conditions');
    expect(yaml).not.toContain('spec.values.domainFilters');
  });
});
