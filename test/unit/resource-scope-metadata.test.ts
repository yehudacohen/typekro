import { describe, expect, it } from 'bun:test';
import { getMetadataField, getResourceScope } from '../../src/core/metadata/index.js';
import {
  kroCustomResourceDefinition,
  resourceGraphDefinition,
} from '../../src/factories/kro/index.js';
import {
  certificateSigningRequest,
  configMap,
  customResourceDefinition,
  ingressClass,
  namespace,
  persistentVolume,
  runtimeClass,
  storageClass,
  validatingWebhookConfiguration,
} from '../../src/factories/kubernetes/index.js';

describe('resource scope metadata', () => {
  it('honors explicit raw scope and leaves unmarked raw resources unresolved', () => {
    expect(
      getResourceScope({
        apiVersion: 'example.com/v1',
        kind: 'ClusterThing',
        metadata: { name: 'demo' },
        scope: 'cluster',
      })
    ).toBe('cluster');
    expect(
      getResourceScope({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'apps' },
      })
    ).toBeUndefined();
  });

  it('factory-created cluster-scoped resources carry scope metadata', () => {
    const resources = [
      namespace({ metadata: { name: 'apps' } }),
      storageClass({ metadata: { name: 'fast' }, provisioner: 'example.com/provisioner' }),
      persistentVolume({
        metadata: { name: 'pv' },
        spec: { capacity: { storage: '1Gi' }, accessModes: ['ReadWriteOnce'] },
      }),
      ingressClass({ metadata: { name: 'public' }, spec: { controller: 'example.com/ingress' } }),
      runtimeClass({ metadata: { name: 'sandboxed' }, handler: 'runsc' }),
      validatingWebhookConfiguration({ metadata: { name: 'validating' }, webhooks: [] }),
      certificateSigningRequest({
        metadata: { name: 'csr' },
        spec: { request: 'LS0t', signerName: 'example.com/signer', usages: ['client auth'] },
      }),
      customResourceDefinition({
        metadata: { name: 'widgets.example.com' },
        spec: {
          group: 'example.com',
          names: { kind: 'Widget', plural: 'widgets' },
          scope: 'Namespaced',
          versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: {} } }],
        },
      }),
      kroCustomResourceDefinition({
        metadata: { name: 'widgets.kro.run' },
        spec: {
          group: 'kro.run',
          names: { kind: 'Widget', plural: 'widgets' },
          scope: 'Namespaced',
          versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: {} } }],
        },
      }),
      resourceGraphDefinition({ metadata: { name: 'widgets' }, spec: {} }),
    ];

    for (const resource of resources) {
      expect(getMetadataField(resource, 'scope')).toBe('cluster');
      expect(getResourceScope(resource)).toBe('cluster');
    }
  });

  it('factory-created namespaced resources do not inherit cluster scope', () => {
    const cm = configMap({ metadata: { name: 'settings', namespace: 'apps' }, data: {} });
    expect(getMetadataField(cm, 'scope')).toBeUndefined();
    expect(getResourceScope(cm)).toBeUndefined();
  });
});
