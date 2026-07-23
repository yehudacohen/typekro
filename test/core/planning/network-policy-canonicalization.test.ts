import { describe, expect, it } from 'bun:test';
import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';
import { networkPolicy } from '../../../src/factories/kubernetes/networking/network-policy.js';
import { toResourceGraph } from '../../../src/index.js';

const policyGraph = toResourceGraph(
  {
    name: 'network-policy-canonicalization',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'NetworkPolicyCanonicalization',
    revision: '1',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (schema) => ({
    policy: networkPolicy({
      id: 'policy',
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: schema.spec.name },
      spec: { podSelector: {}, ingress: [] },
    } as unknown as V1NetworkPolicy),
  }),
  () => ({ ready: true })
);

describe('NetworkPolicy desired canonicalization', () => {
  it('records the decentralized factory canonicalizer in semantic provenance', () => {
    const plan = policyGraph.plan!({ name: 'deny-ingress' }, { strict: true });

    expect(plan.provenance.canonicalizers).toEqual([
      {
        id: 'kubernetes.networking.k8s.io/network-policy',
        revision: '1',
        stage: 'desired',
        factoryName: 'NetworkPolicy',
      },
    ]);
    const desired = JSON.stringify(plan.nodes[0]?.desired);
    expect(desired).toContain('NetworkPolicy');
    expect(desired).not.toContain('ingress');
    expect(desired).toContain('policyTypes');
  });

  it('emits the same stable desired shape through direct and KRO facades', () => {
    const directDocuments = loadAll(
      policyGraph.factory('direct').toYaml({ name: 'deny-ingress' })
    ) as Record<string, unknown>[];
    const directPolicy = directDocuments.find((document) => document.kind === 'NetworkPolicy');
    expect(directPolicy?.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress'] });

    const kroDocuments = loadAll(policyGraph.factory('kro').toYaml()) as Record<string, unknown>[];
    const rgd = kroDocuments.find((document) => document.kind === 'ResourceGraphDefinition') as
      | { spec?: { resources?: { template?: Record<string, unknown> }[] } }
      | undefined;
    const policyTemplate = rgd?.spec?.resources
      ?.map((resource) => resource.template)
      .find((template) => template?.kind === 'NetworkPolicy');

    expect(policyTemplate?.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress'] });
  });
});
