import { describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { from, of } from '@kubernetes/client-node/dist/gen/rxjsStub.js';
import {
  createBunCompatibleApiClient,
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleBatchV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
  createBunCompatibleNetworkingV1Api,
  createBunCompatibleRbacAuthorizationV1Api,
  createBunCompatibleStorageV1Api,
} from '../../../src/core/kubernetes/bun-api-client.js';

/**
 * Helper to create a KubeConfig with a valid cluster for testing.
 * This KubeConfig won't actually connect to anything — it just has
 * enough structure to pass the "has cluster" check.
 */
function createTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {
        name: 'test-cluster',
        server: 'https://127.0.0.1:6443',
        skipTLSVerify: true,
      },
    ],
    users: [{ name: 'test-user', token: 'test-token' }],
    contexts: [
      {
        name: 'test-context',
        cluster: 'test-cluster',
        user: 'test-user',
      },
    ],
    currentContext: 'test-context',
  });
  return kc;
}

/**
 * Helper to create a KubeConfig with no cluster (empty config).
 */
function createEmptyKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [],
    users: [],
    contexts: [],
    currentContext: '',
  });
  return kc;
}

describe('bun-api-client', () => {
  // =========================================================================
  // createBunCompatibleApiClient (generic factory)
  // =========================================================================
  describe('createBunCompatibleApiClient', () => {
    it('creates a CoreV1Api client with valid KubeConfig', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.CoreV1Api);
      expect(client).toBeDefined();
    });

    it('creates an AppsV1Api client with valid KubeConfig', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.AppsV1Api);
      expect(client).toBeDefined();
    });

    it('throws KubernetesClientError when no cluster is configured', () => {
      const kc = createEmptyKubeConfig();
      expect(() => createBunCompatibleApiClient(kc, k8s.CoreV1Api)).toThrow(/No active cluster/);
    });

    it('accepts custom timeout configuration', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.CoreV1Api, {
        default: 5000,
        watch: 60000,
      });
      expect(client).toBeDefined();
    });
  });

  // =========================================================================
  // Convenience wrapper functions
  // =========================================================================
  describe('convenience wrappers', () => {
    it('createBunCompatibleCoreV1Api returns CoreV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleCoreV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleAppsV1Api returns AppsV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleAppsV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleCustomObjectsApi returns CustomObjectsApi', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleCustomObjectsApi(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleBatchV1Api returns BatchV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleBatchV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleNetworkingV1Api returns NetworkingV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleNetworkingV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleRbacAuthorizationV1Api returns RbacAuthorizationV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleRbacAuthorizationV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleStorageV1Api returns StorageV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleStorageV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleApiextensionsV1Api returns ApiextensionsV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiextensionsV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleKubernetesObjectApi returns KubernetesObjectApi', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleKubernetesObjectApi(kc);
      expect(client).toBeDefined();
    });

    it('preserves canonical CRD enum and CEL validation fields on create, patch, replace, and read', async () => {
      const client = createBunCompatibleKubernetesObjectApi(createTestKubeConfig());
      const manifest = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'widgets.example.com' },
        spec: {
          group: 'example.com',
          scope: 'Namespaced',
          names: { kind: 'Widget', plural: 'widgets' },
          versions: [
            {
              name: 'v1',
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      properties: { mode: { type: 'string', enum: ['safe', 'fast'] } },
                      'x-kubernetes-validations': [
                        { rule: 'self.mode == "safe"', message: 'safe mode required' },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      };
      const requests: Array<{ method: string; body: unknown }> = [];
      Reflect.set(client, 'resource', async () => ({
        kind: 'CustomResourceDefinition',
        name: 'customresourcedefinitions',
        namespaced: false,
      }));
      const configuration = Reflect.get(client, 'configuration');
      Reflect.set(configuration, 'httpApi', {
        send(request: { getHttpMethod(): string; getBody(): unknown }) {
          const method = request.getHttpMethod();
          const body = method === 'GET' ? undefined : JSON.parse(String(request.getBody()));
          requests.push({ method, body });
          return of({
            httpStatusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: { text: async () => JSON.stringify(manifest) },
          });
        },
      });

      expect(await client.create(manifest)).toMatchObject(manifest);
      expect(
        await client.patch(
          manifest,
          undefined,
          undefined,
          'test',
          false,
          'application/apply-patch+yaml'
        )
      ).toMatchObject(manifest);
      expect(await client.replace(manifest)).toMatchObject(manifest);
      expect(
        await client.read({
          apiVersion: manifest.apiVersion,
          kind: manifest.kind,
          metadata: { name: manifest.metadata.name },
        })
      ).toMatchObject(manifest);
      for (const request of requests.filter(({ body }) => body !== undefined)) {
        expect(request.body).toMatchObject(manifest);
      }
      expect(requests.map(({ method }) => method)).toEqual(['POST', 'PATCH', 'PUT', 'GET']);
    });

    // Each of these kinds has a field the SDK models under another name
    // (`_from`, `_default`, `_int`); typed serialization dropped the wire spelling.
    const renamedFieldManifests = [
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        plural: 'networkpolicies',
        metadata: { name: 'lapi', namespace: 'crowdsec' },
        spec: {
          podSelector: { matchLabels: { type: 'lapi' } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: { type: 'agent' } } }],
              ports: [{ port: 8080, protocol: 'TCP' }],
            },
          ],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'LimitRange',
        plural: 'limitranges',
        metadata: { name: 'defaults', namespace: 'apps' },
        spec: { limits: [{ type: 'Container', default: { memory: '256Mi' } }] },
      },
      {
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceSlice',
        plural: 'resourceslices',
        metadata: { name: 'node-a-gpu' },
        spec: {
          driver: 'gpu.example.com',
          pool: { name: 'node-a', generation: 1, resourceSliceCount: 1 },
          nodeName: 'node-a',
          devices: [{ name: 'gpu-0', attributes: { index: { int: 0 } } }],
        },
      },
    ];

    for (const { plural, ...manifest } of renamedFieldManifests) {
      it(`preserves ${manifest.kind} wire fields on create, patch, replace, and read`, async () => {
        const client = createBunCompatibleKubernetesObjectApi(createTestKubeConfig());
        const requests: Array<{ method: string; body: unknown }> = [];
        Reflect.set(client, 'resource', async () => ({
          kind: manifest.kind,
          name: plural,
          namespaced: manifest.metadata.namespace !== undefined,
        }));
        const configuration = Reflect.get(client, 'configuration');
        Reflect.set(configuration, 'httpApi', {
          send(request: { getHttpMethod(): string; getBody(): unknown }) {
            const method = request.getHttpMethod();
            const body = method === 'GET' ? undefined : JSON.parse(String(request.getBody()));
            requests.push({ method, body });
            return of({
              httpStatusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: { text: async () => JSON.stringify(manifest) },
            });
          },
        });

        expect(await client.create(manifest)).toMatchObject(manifest);
        expect(
          await client.patch(
            manifest,
            undefined,
            undefined,
            'test',
            false,
            'application/merge-patch+json'
          )
        ).toMatchObject(manifest);
        expect(await client.replace(manifest)).toMatchObject(manifest);
        expect(
          await client.read({
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            metadata: manifest.metadata,
          })
        ).toMatchObject(manifest);
        for (const request of requests.filter(({ body }) => body !== undefined)) {
          expect(request.body).toMatchObject(manifest);
        }
        expect(requests.map(({ method }) => method)).toEqual(['POST', 'PATCH', 'PUT', 'GET']);
      });
    }

    it('rewrites the SDK spellings _from, _default and _int to the wire fields', async () => {
      const client = createBunCompatibleKubernetesObjectApi(createTestKubeConfig());
      const bodies: unknown[] = [];
      Reflect.set(client, 'resource', async () => ({ kind: 'X', name: 'xs', namespaced: true }));
      const configuration = Reflect.get(client, 'configuration');
      Reflect.set(configuration, 'httpApi', {
        send(request: { getHttpMethod(): string; getBody(): unknown }) {
          bodies.push(JSON.parse(String(request.getBody())));
          return of({
            httpStatusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: { text: async () => '{}' },
          });
        },
      });
      const peer = { podSelector: { matchLabels: { type: 'agent' } } };

      await client.create({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'lapi', namespace: 'crowdsec' },
        spec: { podSelector: {}, ingress: [{ _from: [peer], ports: [{ port: 8080 }] }] },
      } as k8s.KubernetesObject);
      await client.create({
        apiVersion: 'v1',
        kind: 'LimitRange',
        metadata: { name: 'defaults', namespace: 'apps' },
        spec: { limits: [{ type: 'Container', _default: { memory: '256Mi' } }] },
      } as k8s.KubernetesObject);
      await client.create({
        apiVersion: 'resource.k8s.io/v1',
        kind: 'ResourceSlice',
        metadata: { name: 'node-a-gpu', namespace: 'unused' },
        spec: { devices: [{ name: 'gpu-0', attributes: { index: { _int: 0 } } }] },
      } as k8s.KubernetesObject);

      expect(bodies).toEqual([
        expect.objectContaining({
          spec: { podSelector: {}, ingress: [{ from: [peer], ports: [{ port: 8080 }] }] },
        }),
        expect.objectContaining({
          spec: { limits: [{ type: 'Container', default: { memory: '256Mi' } }] },
        }),
        expect.objectContaining({
          spec: { devices: [{ name: 'gpu-0', attributes: { index: { int: 0 } } }] },
        }),
      ]);
      for (const body of bodies) {
        expect(JSON.stringify(body)).not.toMatch(/"_(from|default|int)"/);
      }

      await expect(
        client.create({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: { name: 'conflict', namespace: 'crowdsec' },
          spec: { ingress: [{ _from: [peer], from: [] }] },
        } as k8s.KubernetesObject)
      ).rejects.toThrow(/sets "from" twice/);
    });

    it('keeps concurrent CRD and ordinary object serialization separate', async () => {
      const client = createBunCompatibleKubernetesObjectApi(createTestKubeConfig());
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'widgets.example.com' },
        spec: { versions: [{ schema: { openAPIV3Schema: { enum: ['safe'] } } }] },
      };
      const configMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'ordinary', namespace: 'default' },
        data: { mode: 'ordinary' },
      };
      const bodies: unknown[] = [];
      Reflect.set(client, 'resource', async (_version: string, kind: string) => ({
        kind,
        name: kind === 'ConfigMap' ? 'configmaps' : 'customresourcedefinitions',
        namespaced: kind === 'ConfigMap',
      }));
      const configuration = Reflect.get(client, 'configuration');
      Reflect.set(configuration, 'httpApi', {
        send(request: { getBody(): unknown }) {
          const body = JSON.parse(String(request.getBody()));
          bodies.push(body);
          return of({
            httpStatusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: { text: async () => JSON.stringify(body) },
          });
        },
      });

      await Promise.all([client.create(crd), client.create(configMap)]);
      expect(bodies).toContainEqual(crd);
      expect(bodies).toContainEqual(configMap);
    });

    it('does not pass a CRD body into an ordinary request nested by middleware', async () => {
      const client = createBunCompatibleKubernetesObjectApi(createTestKubeConfig());
      const crd = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'widgets.example.com' },
        spec: { versions: [{ schema: { openAPIV3Schema: { enum: ['safe'] } } }] },
      };
      const configMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'ordinary', namespace: 'default' },
        data: { mode: 'ordinary' },
      };
      const deleteOptions = { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 0 };
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      Reflect.set(client, 'resource', async (_version: string, kind: string) => ({
        kind,
        name: kind === 'ConfigMap' ? 'configmaps' : 'customresourcedefinitions',
        namespaced: kind === 'ConfigMap',
      }));
      const configuration = Reflect.get(client, 'configuration');
      Reflect.set(configuration, 'middleware', [
        {
          pre(request: { getUrl(): string }) {
            if (request.getUrl().includes('customresourcedefinitions')) {
              return from(
                Promise.all([
                  client.create(configMap),
                  client.delete(
                    configMap,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    deleteOptions
                  ),
                  client.list('v1', 'ConfigMap', 'default'),
                ]).then(() => request)
              );
            }
            return of(request);
          },
          post: of,
        },
      ]);
      Reflect.set(configuration, 'httpApi', {
        send(request: { getHttpMethod(): string; getUrl(): string; getBody(): unknown }) {
          const method = request.getHttpMethod();
          const body = method === 'GET' ? undefined : JSON.parse(String(request.getBody()));
          requests.push({ method, url: request.getUrl(), body });
          const responseBody =
            method === 'DELETE'
              ? { apiVersion: 'v1', kind: 'Status', status: 'Success' }
              : method === 'GET'
                ? { apiVersion: 'v1', kind: 'ConfigMapList', items: [configMap] }
                : body;
          return of({
            httpStatusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: { text: async () => JSON.stringify(responseBody) },
          });
        },
      });

      await client.create(crd);
      expect(requests).toHaveLength(4);
      expect(
        requests.find(({ method, url }) => method === 'POST' && url.includes('/configmaps'))?.body
      ).toEqual(configMap);
      expect(requests.find(({ method }) => method === 'DELETE')?.body).toEqual(deleteOptions);
      expect(requests.find(({ method }) => method === 'GET')?.body).toBeUndefined();
      expect(requests.find(({ url }) => url.includes('/customresourcedefinitions'))?.body).toEqual(
        crd
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error handling', () => {
    it('all convenience wrappers throw on empty KubeConfig', () => {
      const kc = createEmptyKubeConfig();

      expect(() => createBunCompatibleCoreV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleAppsV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleCustomObjectsApi(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleBatchV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleNetworkingV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleRbacAuthorizationV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleStorageV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleApiextensionsV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleKubernetesObjectApi(kc)).toThrow(/No active cluster/);
    });
  });
});
