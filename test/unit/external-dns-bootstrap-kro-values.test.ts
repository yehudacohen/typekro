import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as jsYaml from 'js-yaml';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { externalDnsBootstrap } from '../../src/factories/external-dns/compositions/external-dns-bootstrap.js';

describe('externalDnsBootstrap KRO Helm values serialization', () => {
  it('emits dynamic Helm values as one spec.values CEL object', () => {
    const yaml = externalDnsBootstrap.toYaml();
    const documents = jsYaml.loadAll(yaml) as Array<{
      kind?: string;
      spec?: { resources?: Array<{ id?: string; template?: { spec?: { values?: unknown } } }> };
    }>;
    const rgd = documents.find((document) => document.kind === 'ResourceGraphDefinition');
    const values = rgd?.spec?.resources?.find(
      (resource) => resource.id === 'externalDnsHelmRelease'
    )?.template?.spec?.values;

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(typeof values).toBe('string');
    expect(values).toStartWith('${{');
    expect(values).toContain('schema.spec.provider');
    expect(values).toContain('schema.spec.domainFilters');
    expect(values).toContain('AWS_SESSION_TOKEN');
    expect(values).toContain('session-token');
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
    const rgd = jsYaml.load(yaml) as {
      spec?: { resources?: Array<{ id?: string; template?: { spec?: { values?: unknown } } }> };
    };
    const values = rgd.spec?.resources?.find(
      (resource) => resource.id === 'externalDnsBootstrap1ExternalDnsHelmRelease'
    )?.template?.spec?.values;

    expect(yaml).toContain('externalDnsBootstrap1ExternalDnsHelmRelease');
    expect(typeof values).toBe('string');
    expect(values).toStartWith('${{');
    expect(values).toContain('"domainFilters": [schema.spec.domain]');
    expect(yaml).toContain('externalDnsBootstrap1ExternalDnsHelmRelease.status.conditions');
    expect(yaml).not.toContain('spec.values.domainFilters');
  });
});
