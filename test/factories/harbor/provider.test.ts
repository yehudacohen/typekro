import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import type { V1ConfigMap, V1Secret } from '@kubernetes/client-node';

import {
  deleteHarborProject,
  HarborApiClient,
  type HarborApiTransport,
  type HarborApiTransportRequest,
  type HarborApiTransportResponse,
  type HarborKubernetesStore,
  prepareHarborRookS3Binding,
  reconcileHarborProject,
} from '../../../src/factories/harbor/index.js';

class MemoryStore implements HarborKubernetesStore {
  readonly secrets = new Map<string, V1Secret>();
  readonly configMaps = new Map<string, V1ConfigMap>();

  async readSecret(namespace: string, name: string): Promise<V1Secret | undefined> {
    return this.secrets.get(`${namespace}/${name}`);
  }

  async readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined> {
    return this.configMaps.get(`${namespace}/${name}`);
  }

  async upsertSecret(secret: V1Secret): Promise<void> {
    this.secrets.set(
      `${secret.metadata?.namespace}/${secret.metadata?.name}`,
      structuredClone(secret)
    );
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.secrets.delete(`${namespace}/${name}`);
  }
}

class FakeHarbor implements HarborApiTransport {
  readonly requests: HarborApiTransportRequest[] = [];
  projectExists = false;
  immutableRule = false;
  retentionId: number | undefined;
  readonly robots: Array<{ id: number; name: string; secret?: string }> = [];
  readonly registries: Array<{ id: number; name: string; url: string; type: string }> = [];
  readonly repositories: string[] = [];

  async request<T>(request: HarborApiTransportRequest): Promise<HarborApiTransportResponse<T>> {
    this.requests.push(structuredClone(request));
    if (request.path === '/projects/chirp' && request.method === 'GET') {
      return response(
        this.projectExists ? 200 : 404,
        this.projectExists
          ? {
              project_id: 7,
              name: 'chirp',
              metadata: this.retentionId ? { retention_id: String(this.retentionId) } : {},
            }
          : undefined
      );
    }
    if (request.path === '/projects' && request.method === 'POST') {
      this.projectExists = true;
      return response(201);
    }
    if (request.path === '/projects/chirp' && request.method === 'PUT') return response(200);
    if (request.path === '/projects/chirp' && request.method === 'DELETE') {
      if (this.repositories.length > 0) return response(412);
      this.projectExists = false;
      return response(200);
    }
    if (request.path.startsWith('/projects/chirp/repositories?page=') && request.method === 'GET') {
      return response(
        200,
        this.repositories.map((name) => ({ name }))
      );
    }
    if (request.path.startsWith('/projects/chirp/repositories/') && request.method === 'DELETE') {
      if (this.immutableRule) return response(412);
      const repository = decodeURIComponent(request.path.split('/').at(-1) ?? '');
      const fullName = `chirp/${repository}`;
      const index = this.repositories.indexOf(fullName);
      if (index >= 0) this.repositories.splice(index, 1);
      return response(index >= 0 ? 200 : 404);
    }
    if (request.path === '/projects/chirp/immutabletagrules' && request.method === 'GET') {
      return response(
        200,
        this.immutableRule
          ? [
              {
                id: 11,
                action: 'immutable',
                tag_selectors: [{ pattern: '**' }],
                scope_selectors: { repository: [{ pattern: '**' }] },
              },
            ]
          : []
      );
    }
    if (request.path === '/projects/chirp/immutabletagrules' && request.method === 'POST') {
      this.immutableRule = true;
      return response(201);
    }
    if (request.path === '/projects/chirp/immutabletagrules/11' && request.method === 'PUT') {
      if ((request.body as { id?: number }).id !== 11) return response(400);
      return response(200);
    }
    if (request.path === '/projects/chirp/immutabletagrules/11' && request.method === 'DELETE') {
      this.immutableRule = false;
      return response(200);
    }
    if (request.path === '/retentions' && request.method === 'POST') {
      this.retentionId = 31;
      return response(201);
    }
    if (request.path === '/retentions/31' && request.method === 'PUT') return response(200);
    if (request.path === '/projects/chirp/scanner' && request.method === 'PUT') {
      return response(200);
    }
    if (request.path.startsWith('/registries?page=') && request.method === 'GET') {
      return response(200, this.registries);
    }
    if (request.path === '/registries/ping' && request.method === 'POST') return response(200);
    if (request.path === '/registries' && request.method === 'POST') {
      const body = request.body as { name: string; url: string; type: string };
      this.registries.push({ id: 9, name: body.name, url: body.url, type: body.type });
      return response(201);
    }
    if (request.path === '/registries/9' && request.method === 'PUT') return response(200);
    if (
      request.path.startsWith('/robots?q=Level%3Dproject%2CProjectID%3D7&page=') &&
      request.method === 'GET'
    ) {
      return response(
        200,
        this.robots.map(({ secret: _secret, ...robot }) => robot)
      );
    }
    if (request.path === '/robots' && request.method === 'POST') {
      const name = (request.body as { name: string }).name;
      const robot = { id: this.robots.length + 20, name: `robot$${name}`, secret: `token-${name}` };
      this.robots.push(robot);
      return response(201, robot);
    }
    if (request.path.startsWith('/robots/') && request.method === 'PATCH') {
      const id = Number(request.path.split('/').at(-1));
      const robot = this.robots.find((candidate) => candidate.id === id);
      return response(200, { secret: `rotated-${robot?.name}` });
    }
    if (request.path.startsWith('/robots/') && request.method === 'PUT') return response(200);
    return response(500, { message: 'unhandled fake request' });
  }
}

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string | string[] | undefined> = {}
): HarborApiTransportResponse<never> {
  return {
    status,
    ...(body === undefined ? {} : { body }),
    headers,
  } as unknown as HarborApiTransportResponse<never>;
}

describe('Harbor direct preparation providers', () => {
  it('copies OBC credentials between Secrets without decoding or returning them', async () => {
    const store = new MemoryStore();
    const access = Buffer.from('access-value').toString('base64');
    const secret = Buffer.from('secret-value').toString('base64');
    store.secrets.set('rook/harbor-bucket', {
      metadata: { name: 'harbor-bucket', namespace: 'rook' },
      data: { AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret },
    });
    store.configMaps.set('rook/harbor-bucket', {
      metadata: { name: 'harbor-bucket', namespace: 'rook' },
      data: {
        BUCKET_NAME: 'generated-harbor-bucket',
        BUCKET_HOST: 'rook-ceph-rgw.rook.svc',
        BUCKET_PORT: '80',
        BUCKET_REGION: 'us-east-1',
      },
    });

    const prepared = await prepareHarborRookS3Binding({
      sourceNamespace: 'rook',
      claimName: 'harbor-bucket',
      targetNamespace: 'harbor',
      targetSecretName: 'harbor-s3',
      store,
    });
    expect(prepared).toEqual({
      bucket: 'generated-harbor-bucket',
      region: 'us-east-1',
      regionEndpoint: 'http://rook-ceph-rgw.rook.svc:80',
      existingSecret: 'harbor-s3',
      secure: false,
    });
    expect(JSON.stringify(prepared)).not.toContain('access-value');
    expect(JSON.stringify(prepared)).not.toContain('secret-value');
    expect(store.secrets.get('harbor/harbor-s3')).toMatchObject({
      type: 'Opaque',
      data: {
        REGISTRY_STORAGE_S3_ACCESSKEY: access,
        REGISTRY_STORAGE_S3_SECRETKEY: secret,
      },
    });

    store.configMaps.get('rook/harbor-bucket')!.data!.BUCKET_REGION = '';
    const blankRegion = await prepareHarborRookS3Binding({
      sourceNamespace: 'rook',
      claimName: 'harbor-bucket',
      targetNamespace: 'harbor',
      targetSecretName: 'harbor-s3-blank-region',
      store,
    });
    expect(blankRegion.region).toBe('us-east-1');
  });

  it('fails closed when either generated OBC binding is missing or malformed', async () => {
    const store = new MemoryStore();
    await expect(
      prepareHarborRookS3Binding({
        sourceNamespace: 'rook',
        claimName: 'missing',
        targetNamespace: 'harbor',
        targetSecretName: 'harbor-s3',
        store,
      })
    ).rejects.toThrow('credential Secret rook/missing is not available');
  });

  it('idempotently reconciles a private project, immutability, and separate pull/push robots', async () => {
    const transport = new FakeHarbor();
    const client = new HarborApiClient(transport);
    const store = new MemoryStore();
    const options = {
      project: {
        name: 'chirp',
        public: false,
        storageLimitBytes: 20_000_000_000,
        autoScan: true,
        autoSbomGeneration: true,
        proxyCache: {
          name: 'docker-hub',
          url: 'https://registry-1.docker.io',
          type: 'docker-hub',
          credentialProvider: async () => ({
            username: 'upstream-reader',
            password: 'upstream-secret',
          }),
        },
        scannerUuid: 'trivy-adapter-uuid',
        immutableTags: {},
        retention: { keepMostRecent: 20, scheduleCron: '0 0 2 * * *' },
      },
      robots: [
        { name: 'chirp-pull', secretName: 'chirp-pull', access: 'pull' as const },
        { name: 'chirp-push', secretName: 'chirp-push', access: 'push' as const },
      ],
      secretNamespace: 'chirp',
      registry: 'https://harbor.orb.local',
      store,
    };

    const first = await reconcileHarborProject(client, options);
    expect(first).toEqual({
      project: 'chirp',
      projectId: 7,
      robots: [
        { name: 'robot$chirp-pull', id: 20, secretName: 'chirp-pull', access: 'pull' },
        { name: 'robot$chirp-push', id: 21, secretName: 'chirp-push', access: 'push' },
      ],
    });
    const pullConfig = JSON.parse(
      Buffer.from(
        store.secrets.get('chirp/chirp-pull')?.data?.['.dockerconfigjson'] ?? '',
        'base64'
      ).toString('utf8')
    ) as { auths: Record<string, { username: string; password: string }> };
    expect(pullConfig.auths['harbor.orb.local']).toMatchObject({
      username: 'robot$chirp-pull',
      password: 'token-chirp-pull',
    });

    const createCount = transport.requests.filter(
      (request) => request.method === 'POST' && request.path === '/robots'
    ).length;
    await reconcileHarborProject(client, options);
    expect(
      transport.requests.filter(
        (request) => request.method === 'POST' && request.path === '/robots'
      )
    ).toHaveLength(createCount);
    expect(transport.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
    expect(
      transport.requests.filter(
        (request) => request.method === 'PUT' && request.path.startsWith('/robots/')
      )
    ).toHaveLength(2);
    expect(
      transport.requests.find(
        (request) => request.method === 'PUT' && request.path === '/robots/21'
      )?.body
    ).toMatchObject({
      disable: false,
      permissions: [
        {
          kind: 'project',
          namespace: 'chirp',
          access: [
            { resource: 'repository', action: 'pull', effect: 'allow' },
            { resource: 'repository', action: 'push', effect: 'allow' },
          ],
        },
      ],
    });

    const projectCreate = transport.requests.find(
      (request) => request.method === 'POST' && request.path === '/projects'
    );
    expect(projectCreate?.body).toMatchObject({
      project_name: 'chirp',
      public: false,
      storage_limit: 20_000_000_000,
      registry_id: 9,
      metadata: { public: 'false', auto_scan: 'true', auto_sbom_generation: 'true' },
    });
    expect(
      transport.requests.find((request) => request.path === '/registries/ping')?.body
    ).toMatchObject({
      name: 'docker-hub',
      url: 'https://registry-1.docker.io',
      type: 'docker-hub',
      credential_type: 'basic',
      access_key: 'upstream-reader',
      access_secret: 'upstream-secret',
    });
    expect(
      transport.requests.find(
        (request) => request.method === 'POST' && request.path === '/registries'
      )?.body
    ).toMatchObject({
      name: 'docker-hub',
      url: 'https://registry-1.docker.io',
      type: 'docker-hub',
      credential: {
        type: 'basic',
        access_key: 'upstream-reader',
        access_secret: 'upstream-secret',
      },
    });
    const pushCreate = transport.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === '/robots' &&
        (request.body as { name?: string }).name === 'chirp-push'
    );
    expect(pushCreate?.body).toMatchObject({
      permissions: [
        {
          kind: 'project',
          namespace: 'chirp',
          access: [
            { resource: 'repository', action: 'pull', effect: 'allow' },
            { resource: 'repository', action: 'push', effect: 'allow' },
          ],
        },
      ],
    });
    expect(
      transport.requests.find(
        (request) => request.method === 'POST' && request.path === '/retentions'
      )?.body
    ).toMatchObject({
      algorithm: 'or',
      rules: [
        {
          template: 'latestPushedK',
          params: { latestPushedK: 20 },
          scope_selectors: {
            repository: [{ decoration: 'repoMatches', pattern: '**' }],
          },
        },
      ],
      trigger: { kind: 'Schedule', settings: { cron: '0 0 2 * * *' } },
      scope: { level: 'project', ref: 7 },
    });
    expect(
      transport.requests.find(
        (request) => request.method === 'PUT' && request.path === '/retentions/31'
      )
    ).toBeDefined();
    expect(
      transport.requests.find(
        (request) => request.method === 'PUT' && request.path === '/projects/chirp/scanner'
      )?.body
    ).toEqual({ uuid: 'trivy-adapter-uuid' });
  });

  it('rotates an existing robot only when its one-time credential Secret is absent', async () => {
    const transport = new FakeHarbor();
    transport.projectExists = true;
    transport.robots.push({ id: 20, name: 'robot$chirp-pull' });
    const store = new MemoryStore();
    const result = await reconcileHarborProject(new HarborApiClient(transport), {
      project: { name: 'chirp' },
      robots: [{ name: 'chirp-pull', secretName: 'chirp-pull', access: 'pull' }],
      secretNamespace: 'chirp',
      registry: 'harbor.orb.local',
      store,
    });
    expect(result.robots[0]).toMatchObject({ id: 20, name: 'robot$chirp-pull' });
    expect(transport.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(store.secrets.get('chirp/chirp-pull')).toBeDefined();
  });

  it('finds an official project-prefixed robot on a later bounded page', async () => {
    const robotName = 'robot$chirp+pull';
    const store = new MemoryStore();
    store.secrets.set('chirp/chirp-pull', {
      metadata: { name: 'chirp-pull', namespace: 'chirp' },
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        '.dockerconfigjson': Buffer.from(
          JSON.stringify({
            auths: {
              'harbor.orb.local': { username: robotName, password: 'retained-secret' },
            },
          })
        ).toString('base64'),
      },
    });
    const requests: HarborApiTransportRequest[] = [];
    const transport: HarborApiTransport = {
      async request<T>(request: HarborApiTransportRequest) {
        requests.push(request);
        if (request.path === '/projects/chirp' && request.method === 'GET') {
          return response(200, {
            project_id: 7,
            name: 'chirp',
            metadata: {},
          }) as HarborApiTransportResponse<T>;
        }
        if (request.path === '/projects/chirp' && request.method === 'PUT')
          return response(200) as HarborApiTransportResponse<T>;
        if (request.path === '/robots?q=Level%3Dproject%2CProjectID%3D7&page=1&page_size=100') {
          return response(
            200,
            Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              name: `robot$other+${index}`,
            })),
            { 'x-total-count': '101' }
          ) as HarborApiTransportResponse<T>;
        }
        if (request.path === '/robots?q=Level%3Dproject%2CProjectID%3D7&page=2&page_size=100') {
          return response(200, [{ id: 501, name: robotName, expires_at: -1 }], {
            'x-total-count': '101',
          }) as HarborApiTransportResponse<T>;
        }
        if (request.path === '/robots/501' && request.method === 'PUT')
          return response(200) as HarborApiTransportResponse<T>;
        return response(500) as HarborApiTransportResponse<T>;
      },
    };
    const reconciled = await reconcileHarborProject(new HarborApiClient(transport), {
      project: { name: 'chirp' },
      robots: [{ name: 'pull', secretName: 'chirp-pull', access: 'pull' }],
      secretNamespace: 'chirp',
      registry: 'harbor.orb.local',
      store,
    });
    expect(reconciled.robots).toEqual([
      { name: robotName, id: 501, secretName: 'chirp-pull', access: 'pull' },
    ]);
    expect(
      requests.some(
        (request) =>
          request.path === '/robots?q=Level%3Dproject%2CProjectID%3D7&page=2&page_size=100'
      )
    ).toBe(true);
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('requires exact confirmation for destructive project deletion', async () => {
    const transport = new FakeHarbor();
    transport.projectExists = true;
    const client = new HarborApiClient(transport);
    const store = new MemoryStore();
    store.secrets.set('chirp/chirp-pull', {
      metadata: { name: 'chirp-pull', namespace: 'chirp' },
    });
    store.secrets.set('chirp/chirp-push', {
      metadata: { name: 'chirp-push', namespace: 'chirp' },
    });
    await expect(
      deleteHarborProject(client, 'chirp', { confirmProjectName: 'wrong' })
    ).rejects.toThrow('confirmation does not match');
    await expect(
      deleteHarborProject(client, 'chirp', {
        confirmProjectName: 'chirp',
        robotSecretNames: ['chirp-pull'],
      })
    ).rejects.toThrow('secretNamespace is required');
    await deleteHarborProject(client, 'chirp', {
      confirmProjectName: 'chirp',
      secretNamespace: 'chirp',
      robotSecretNames: ['chirp-pull', 'chirp-push', 'chirp-pull'],
      store,
    });
    expect(transport.projectExists).toBe(false);
    expect(store.secrets.size).toBe(0);
  });

  it('purges a non-empty project only with explicit confirmation and waits before deleting Secrets', async () => {
    const transport = new FakeHarbor();
    transport.projectExists = true;
    transport.immutableRule = true;
    transport.repositories.push('chirp/typekro-oci-smoke');
    const client = new HarborApiClient(transport);
    const store = new MemoryStore();
    store.secrets.set('chirp/chirp-pull', {
      metadata: { name: 'chirp-pull', namespace: 'chirp' },
    });

    await expect(
      deleteHarborProject(client, 'chirp', {
        confirmProjectName: 'chirp',
        secretNamespace: 'chirp',
        robotSecretNames: ['chirp-pull'],
        store,
      })
    ).rejects.toMatchObject({ status: 412 });
    expect(store.secrets.has('chirp/chirp-pull')).toBe(true);

    await deleteHarborProject(client, 'chirp', {
      confirmProjectName: 'chirp',
      purgeRepositories: true,
      secretNamespace: 'chirp',
      robotSecretNames: ['chirp-pull'],
      store,
    });

    expect(transport.repositories).toEqual([]);
    expect(transport.projectExists).toBe(false);
    expect(store.secrets.has('chirp/chirp-pull')).toBe(false);
    expect(
      transport.requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.path === '/projects/chirp/repositories/typekro-oci-smoke'
      )
    ).toBe(true);
    const ruleDeletion = transport.requests.findIndex(
      (request) =>
        request.method === 'DELETE' &&
        request.path === '/projects/chirp/immutabletagrules/11'
    );
    const repositoryDeletion = transport.requests.findIndex(
      (request) =>
        request.method === 'DELETE' &&
        request.path === '/projects/chirp/repositories/typekro-oci-smoke'
    );
    expect(ruleDeletion).toBeGreaterThanOrEqual(0);
    expect(repositoryDeletion).toBeGreaterThan(ruleDeletion);
  });

  it('redacts response bodies from Harbor API failures', async () => {
    const client = new HarborApiClient({
      async request() {
        return response(500, { secret: 'never-print-me' });
      },
    });
    await expect(client.request({ method: 'GET', path: '/projects/chirp' })).rejects.not.toThrow(
      'never-print-me'
    );
  });

  it('refuses to send Harbor Basic credentials over plain HTTP by default', () => {
    expect(
      () =>
        new HarborApiClient({
          endpoint: 'http://registry.example.test',
          credentialProvider: async () => ({ username: 'admin', password: 'secret' }),
        })
    ).toThrow('refuses to send Basic credentials over plain HTTP');
    expect(
      () =>
        new HarborApiClient({
          endpoint: 'http://127.0.0.1:32080',
          allowPlainHttp: true,
          credentialProvider: async () => ({ username: 'admin', password: 'secret' }),
        })
    ).not.toThrow();
  });
});
