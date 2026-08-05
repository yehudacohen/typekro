import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';

import type { V1Secret } from '@kubernetes/client-node';

import type { OciRegistryCredentialProvider } from '../../../core/containers/registries/types.js';
import type { KubernetesClientConfig } from '../../../core/kubernetes/client-provider.js';
import {
  createHarborKubernetesStore,
  type HarborKubernetesStore,
} from './kubernetes-secret-store.js';

export interface HarborApiTransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown | undefined;
  signal?: AbortSignal | undefined;
}

export interface HarborApiTransportResponse<T = unknown> {
  status: number;
  body?: T | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export interface HarborApiTransport {
  request<T = unknown>(request: HarborApiTransportRequest): Promise<HarborApiTransportResponse<T>>;
}

export interface HarborApiClientOptions {
  endpoint: string;
  credentialProvider: OciRegistryCredentialProvider;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
  /** Permit Basic authentication over plain HTTP. Development loopback only. */
  allowPlainHttp?: boolean;
  timeoutMs?: number;
}

export interface HarborProjectPolicy {
  name: string;
  public?: boolean;
  storageLimitBytes?: number;
  autoScan?: boolean;
  autoSbomGeneration?: boolean;
  /** Existing Harbor registry endpoint registration used to create a proxy-cache project. */
  proxyCacheRegistryId?: number;
  /** Declaratively create/update the proxy-cache registry endpoint before the project. */
  proxyCache?: HarborProxyCacheRegistryPolicy;
  /** Existing scanner registration UUID assigned to the project. */
  scannerUuid?: string;
  immutableTags?: {
    repositoryPattern?: string;
    tagPattern?: string;
  };
  retention?: {
    keepMostRecent: number;
    scheduleCron?: string;
    repositoryPattern?: string;
    tagPattern?: string;
    includeUntagged?: boolean;
  };
}

export interface HarborProxyCacheRegistryPolicy {
  name: string;
  url: string;
  /** Harbor adapter type such as docker-hub, harbor, aws-ecr, or github-ghcr. */
  type: string;
  description?: string;
  insecure?: boolean;
  caCertificate?: string;
  credentialProvider?: OciRegistryCredentialProvider;
}

export interface HarborRobotPolicy {
  name: string;
  secretName: string;
  access: 'pull' | 'push';
  description?: string;
  durationDays?: number;
}

export interface ReconcileHarborProjectOptions {
  project: HarborProjectPolicy;
  robots: HarborRobotPolicy[];
  secretNamespace: string;
  registry: string;
  kubeConfig?: KubernetesClientConfig;
  store?: HarborKubernetesStore;
  signal?: AbortSignal;
}

export interface ReconciledHarborProject {
  project: string;
  projectId: number;
  robots: Array<{ name: string; id: number; secretName: string; access: 'pull' | 'push' }>;
}

export interface DeleteHarborProjectOptions {
  /** Destructive confirmation; must exactly match the project argument. */
  confirmProjectName: string;
  /**
   * Delete every repository in the confirmed project before deleting it.
   * Harbor rejects non-empty project deletion; this remains opt-in because
   * repository deletion is irreversible.
   */
  purgeRepositories?: boolean;
  /** Bounded repository/project deletion convergence window. @default 60000 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Namespace containing robot pull/push Secrets created for this project. */
  secretNamespace?: string;
  /** Explicit project-owned robot Secret names to remove after Harbor accepts deletion. */
  robotSecretNames?: readonly string[];
  kubeConfig?: KubernetesClientConfig;
  store?: HarborKubernetesStore;
}

interface HarborProjectResponse {
  project_id?: number;
  name?: string;
  metadata?: Record<string, string | undefined>;
}

interface HarborRobotResponse {
  id?: number;
  name?: string;
  secret?: string;
  disable?: boolean;
  duration?: number;
  expires_at?: number;
  description?: string;
  level?: string;
  permissions?: Array<{
    kind: string;
    namespace: string;
    access: Array<{ resource: string; action: string; effect: string }>;
  }>;
}

interface HarborRegistryResponse {
  id?: number;
  name?: string;
  url?: string;
  type?: string;
  insecure?: boolean;
}

interface HarborRepositoryResponse {
  name?: string;
}

interface HarborImmutableRule {
  id?: number;
  disabled?: boolean;
  action?: string;
  template?: string;
  tag_selectors?: HarborSelector[];
  scope_selectors?: Record<string, HarborSelector[]>;
}

interface HarborSelector {
  kind: string;
  decoration: string;
  pattern: string;
}

/** Error intentionally excludes response/request bodies because robot secrets can appear there. */
export class HarborApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string
  ) {
    super(message);
    this.name = 'HarborApiError';
  }
}

/** Pinned Harbor v2 API client with bounded Node HTTP transport and custom CA support. */
export class HarborApiClient {
  readonly transport: HarborApiTransport;

  constructor(options: HarborApiClientOptions | HarborApiTransport) {
    this.transport = 'request' in options ? options : createNodeHarborApiTransport(options);
  }

  async request<T = unknown>(
    request: HarborApiTransportRequest,
    allowedStatuses: number[] = [200]
  ): Promise<HarborApiTransportResponse<T>> {
    const response = await this.transport.request<T>(request);
    if (!allowedStatuses.includes(response.status)) {
      throw new HarborApiError(
        `Harbor API ${request.method} ${request.path} returned HTTP ${response.status}.`,
        response.status,
        request.path
      );
    }
    return response;
  }
}

/** Reconcile one private project, its immutable-tag policy, and purpose-scoped robot Secrets. */
export async function reconcileHarborProject(
  client: HarborApiClient,
  options: ReconcileHarborProjectOptions
): Promise<ReconciledHarborProject> {
  validateProjectName(options.project.name);
  if (options.project.proxyCache && options.project.proxyCacheRegistryId !== undefined) {
    throw new Error(
      'Harbor project must select either proxyCache or proxyCacheRegistryId, not both.'
    );
  }
  const proxyCacheRegistryId = options.project.proxyCache
    ? await reconcileProxyCacheRegistry(client, options.project.proxyCache, options.signal)
    : options.project.proxyCacheRegistryId;
  const project = await reconcileProject(
    client,
    options.project,
    proxyCacheRegistryId,
    options.signal
  );
  if (options.project.immutableTags) {
    await reconcileImmutableRule(
      client,
      options.project.name,
      options.project.immutableTags,
      options.signal
    );
  }
  if (options.project.retention) {
    await reconcileRetentionPolicy(
      client,
      project.projectId,
      project.metadata?.retention_id,
      options.project.retention,
      options.signal
    );
  }
  if (options.project.scannerUuid) {
    await client.request(
      {
        method: 'PUT',
        path: `/projects/${encodeURIComponent(options.project.name)}/scanner`,
        body: { uuid: options.project.scannerUuid },
        signal: options.signal,
      },
      [200]
    );
  }

  const store = options.store ?? createHarborKubernetesStore(options.kubeConfig);
  const robots: ReconciledHarborProject['robots'] = [];
  for (const policy of options.robots) {
    robots.push(
      await reconcileRobot(
        client,
        store,
        options.project.name,
        project.projectId,
        options.secretNamespace,
        policy,
        {
          registry: options.registry,
          signal: options.signal,
        }
      )
    );
  }
  return { project: options.project.name, projectId: project.projectId, robots };
}

/** Project deletion is deliberately separate and requires an exact-name confirmation. */
export async function deleteHarborProject(
  client: HarborApiClient,
  project: string,
  options: DeleteHarborProjectOptions
): Promise<void> {
  validateProjectName(project);
  if (options.confirmProjectName !== project) {
    throw new Error(`Refusing to delete Harbor project ${project}: confirmation does not match.`);
  }
  const secretNames = [...new Set(options.robotSecretNames ?? [])];
  if (secretNames.length > 0 && !options.secretNamespace) {
    throw new Error(
      `Refusing to delete Harbor project ${project}: secretNamespace is required when robotSecretNames are supplied.`
    );
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Harbor project deletion timeoutMs must be a positive finite number.');
  }
  if (options.purgeRepositories) {
    // Harbor enforces immutable-tag rules on repository deletion as well as
    // pushes. Exact-name confirmation plus purgeRepositories already grants
    // destructive authority over the complete project, so remove every
    // project rule before purging its repositories. Leaving the rules in place
    // makes TypeKro's own managed immutable policy render confirmed teardown
    // impossible with HTTP 412.
    await removeHarborProjectImmutableRules(client, project, options.signal);
    await purgeHarborProjectRepositories(client, project, timeoutMs, options.signal);
  }
  const deletion = await client.request(
    {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(project)}`,
      signal: options.signal,
    },
    [200, 404]
  );
  if (deletion.status !== 404) {
    await waitForHarborProjectAbsent(client, project, timeoutMs, options.signal);
  }
  if (secretNames.length > 0 && options.secretNamespace) {
    const store = options.store ?? createHarborKubernetesStore(options.kubeConfig);
    await Promise.all(
      secretNames.map((name) => store.deleteSecret(options.secretNamespace as string, name))
    );
  }
}

async function removeHarborProjectImmutableRules(
  client: HarborApiClient,
  project: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const path = `/projects/${encodeURIComponent(project)}/immutabletagrules`;
  const listed = await client.request<HarborImmutableRule[]>(
    { method: 'GET', path, signal },
    [200, 404]
  );
  if (listed.status === 404) return;
  for (const rule of listed.body ?? []) {
    if (!Number.isInteger(rule.id)) {
      throw new HarborApiError(
        `Harbor immutable-tag rule for project ${project} was missing its ID.`,
        200,
        path
      );
    }
    await client.request(
      {
        method: 'DELETE',
        path: `${path}/${rule.id as number}`,
        signal,
      },
      [200, 204, 404]
    );
  }
}

async function purgeHarborProjectRepositories(
  client: HarborApiClient,
  project: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const projectPath = `/projects/${encodeURIComponent(project)}`;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const repositories = await listHarborResources<HarborRepositoryResponse>(
      client,
      `${projectPath}/repositories`,
      signal
    ).catch((error: unknown) => {
      if (error instanceof HarborApiError && error.status === 404) return [];
      throw error;
    });
    if (repositories.length === 0) return;

    await runWithConcurrency(repositories, 4, async (repository) => {
      const fullName = repository.name;
      if (!fullName) {
        throw new HarborApiError(
          'Harbor repository response was missing its name.',
          200,
          `${projectPath}/repositories`
        );
      }
      const prefix = `${project}/`;
      const repositoryName = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
      await client.request(
        {
          method: 'DELETE',
          path: `${projectPath}/repositories/${encodeURIComponent(repositoryName)}`,
          signal,
        },
        [200, 202, 404]
      );
    });
    await harborDeletionDelay(500, signal);
  }
  throw new HarborApiError(
    `Timed out after ${timeoutMs}ms purging repositories from Harbor project ${project}.`,
    undefined,
    `/projects/${encodeURIComponent(project)}/repositories`
  );
}

async function waitForHarborProjectAbsent(
  client: HarborApiClient,
  project: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  const path = `/projects/${encodeURIComponent(project)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const response = await client.transport.request({ method: 'GET', path, signal });
    if (response.status === 404) return;
    if (response.status !== 200) {
      throw new HarborApiError(
        `Harbor API GET ${path} returned HTTP ${response.status}.`,
        response.status,
        path
      );
    }
    await harborDeletionDelay(500, signal);
  }
  throw new HarborApiError(
    `Timed out after ${timeoutMs}ms waiting for Harbor project ${project} deletion.`,
    undefined,
    path
  );
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        if (item !== undefined) await operation(item);
      }
    })
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

async function harborDeletionDelay(
  milliseconds: number,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Operation aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function reconcileProject(
  client: HarborApiClient,
  policy: HarborProjectPolicy,
  proxyCacheRegistryId: number | undefined,
  signal: AbortSignal | undefined
): Promise<{ projectId: number; metadata?: Record<string, string | undefined> }> {
  const path = `/projects/${encodeURIComponent(policy.name)}`;
  const current = await client.transport.request<HarborProjectResponse>({
    method: 'GET',
    path,
    signal,
  });
  const body = projectRequest(policy, proxyCacheRegistryId);
  if (current.status === 404) {
    await client.request({ method: 'POST', path: '/projects', body, signal }, [201, 409]);
  } else if (current.status === 200) {
    await client.request({ method: 'PUT', path, body, signal }, [200]);
  } else {
    throw new HarborApiError(
      `Harbor API GET ${path} returned HTTP ${current.status}.`,
      current.status,
      path
    );
  }
  const resolved = await client.request<HarborProjectResponse>(
    { method: 'GET', path, signal },
    [200]
  );
  const projectId = resolved.body?.project_id;
  if (!Number.isInteger(projectId)) {
    throw new HarborApiError(
      'Harbor project response did not contain a numeric project ID.',
      200,
      path
    );
  }
  return {
    projectId: projectId as number,
    ...(resolved.body?.metadata ? { metadata: resolved.body.metadata } : {}),
  };
}

function projectRequest(
  policy: HarborProjectPolicy,
  proxyCacheRegistryId: number | undefined
): Record<string, unknown> {
  return {
    project_name: policy.name,
    public: policy.public ?? false,
    ...(policy.storageLimitBytes !== undefined ? { storage_limit: policy.storageLimitBytes } : {}),
    ...(proxyCacheRegistryId !== undefined ? { registry_id: proxyCacheRegistryId } : {}),
    metadata: {
      public: String(policy.public ?? false),
      auto_scan: String(policy.autoScan ?? true),
      auto_sbom_generation: String(policy.autoSbomGeneration ?? true),
    },
  };
}

async function reconcileProxyCacheRegistry(
  client: HarborApiClient,
  policy: HarborProxyCacheRegistryPolicy,
  signal: AbortSignal | undefined
): Promise<number> {
  if (!policy.name.trim() || !policy.url.trim() || !policy.type.trim()) {
    throw new Error('Harbor proxy-cache registry requires non-empty name, url, and type.');
  }
  const credential = policy.credentialProvider
    ? await policy.credentialProvider(signal)
    : undefined;
  const listed = await listHarborResources<HarborRegistryResponse>(client, '/registries', signal);
  const existing = listed.find((registry) => registry.name === policy.name);
  const createBody = {
    name: policy.name,
    url: policy.url,
    type: policy.type,
    insecure: policy.insecure ?? false,
    description: policy.description ?? `TypeKro-managed proxy cache ${policy.name}`,
    ...(policy.caCertificate ? { ca_certificate: policy.caCertificate } : {}),
    ...(credential
      ? {
          credential: {
            type: 'basic',
            access_key: credential.username,
            access_secret: credential.password,
          },
        }
      : {}),
  };
  const pingBody = {
    name: policy.name,
    url: policy.url,
    type: policy.type,
    insecure: policy.insecure ?? false,
    ...(policy.caCertificate ? { ca_certificate: policy.caCertificate } : {}),
    ...(credential
      ? {
          credential_type: 'basic',
          access_key: credential.username,
          access_secret: credential.password,
        }
      : {}),
  };
  await client.request({ method: 'POST', path: '/registries/ping', body: pingBody, signal }, [200]);
  if (existing?.id !== undefined) {
    await client.request(
      {
        method: 'PUT',
        path: `/registries/${existing.id}`,
        body: {
          name: policy.name,
          url: policy.url,
          insecure: policy.insecure ?? false,
          description: policy.description ?? `TypeKro-managed proxy cache ${policy.name}`,
          ...(policy.caCertificate ? { ca_certificate: policy.caCertificate } : {}),
          ...(credential
            ? {
                credential_type: 'basic',
                access_key: credential.username,
                access_secret: credential.password,
              }
            : {}),
        },
        signal,
      },
      [200]
    );
    return existing.id;
  }
  await client.request({ method: 'POST', path: '/registries', body: createBody, signal }, [201]);
  const created = (
    await listHarborResources<HarborRegistryResponse>(client, '/registries', signal)
  ).find((registry) => registry.name === policy.name);
  if (created?.id === undefined) {
    throw new HarborApiError(
      `Harbor registry endpoint ${policy.name} was created but could not be resolved.`,
      201,
      '/registries'
    );
  }
  return created.id;
}

async function reconcileRetentionPolicy(
  client: HarborApiClient,
  projectId: number,
  existingRetentionId: string | undefined,
  policy: NonNullable<HarborProjectPolicy['retention']>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!Number.isInteger(policy.keepMostRecent) || policy.keepMostRecent < 1) {
    throw new Error('Harbor retention keepMostRecent must be an integer greater than zero.');
  }
  const desired = {
    algorithm: 'or',
    rules: [
      {
        priority: 1,
        disabled: false,
        action: 'retain',
        template: 'latestPushedK',
        params: { latestPushedK: policy.keepMostRecent },
        tag_selectors: [
          {
            kind: 'doublestar',
            decoration: 'matches',
            pattern: policy.tagPattern ?? '**',
            extras: JSON.stringify({ untagged: policy.includeUntagged ?? true }),
          },
        ],
        scope_selectors: {
          repository: [
            {
              kind: 'doublestar',
              decoration: 'repoMatches',
              pattern: policy.repositoryPattern ?? '**',
            },
          ],
        },
      },
    ],
    trigger: {
      kind: 'Schedule',
      settings: { cron: policy.scheduleCron ?? '0 0 0 * * *' },
      references: {},
    },
    scope: { level: 'project', ref: projectId },
  };
  const parsedId = Number(existingRetentionId);
  if (Number.isInteger(parsedId) && parsedId > 0) {
    await client.request(
      { method: 'PUT', path: `/retentions/${parsedId}`, body: desired, signal },
      [200]
    );
    return;
  }
  await client.request({ method: 'POST', path: '/retentions', body: desired, signal }, [201]);
}

async function reconcileImmutableRule(
  client: HarborApiClient,
  project: string,
  policy: NonNullable<HarborProjectPolicy['immutableTags']>,
  signal: AbortSignal | undefined
): Promise<void> {
  const path = `/projects/${encodeURIComponent(project)}/immutabletagrules`;
  const repositoryPattern = policy.repositoryPattern ?? '**';
  const tagPattern = policy.tagPattern ?? '**';
  const desired: HarborImmutableRule = {
    disabled: false,
    action: 'immutable',
    template: 'immutable_template',
    tag_selectors: [{ kind: 'doublestar', decoration: 'matches', pattern: tagPattern }],
    scope_selectors: {
      repository: [{ kind: 'doublestar', decoration: 'repoMatches', pattern: repositoryPattern }],
    },
  };
  const listed = await client.request<HarborImmutableRule[]>(
    { method: 'GET', path, signal },
    [200]
  );
  const existing = (listed.body ?? []).find(
    (rule) =>
      rule.action === 'immutable' &&
      rule.tag_selectors?.[0]?.pattern === tagPattern &&
      rule.scope_selectors?.repository?.[0]?.pattern === repositoryPattern
  );
  if (existing?.id !== undefined) {
    await client.request(
      {
        method: 'PUT',
        path: `${path}/${existing.id}`,
        // Harbor rejects updates unless the payload ID exactly matches the path ID.
        body: { ...desired, id: existing.id },
        signal,
      },
      [200]
    );
  } else {
    await client.request({ method: 'POST', path, body: desired, signal }, [201]);
  }
}

async function reconcileRobot(
  client: HarborApiClient,
  store: HarborKubernetesStore,
  project: string,
  projectId: number,
  secretNamespace: string,
  policy: HarborRobotPolicy,
  options: { registry: string; signal?: AbortSignal | undefined }
): Promise<{ name: string; id: number; secretName: string; access: 'pull' | 'push' }> {
  validateRobotName(policy.name);
  if (
    policy.durationDays !== undefined &&
    policy.durationDays !== -1 &&
    (!Number.isInteger(policy.durationDays) || policy.durationDays < 1)
  ) {
    throw new Error('Harbor robot durationDays must be -1 or a positive integer.');
  }
  const secret = await store.readSecret(secretNamespace, policy.secretName);
  const projectQuery = encodeURIComponent(`Level=project,ProjectID=${projectId}`);
  const listed = await listHarborResources<HarborRobotResponse>(
    client,
    `/robots?q=${projectQuery}`,
    options.signal
  );
  const existing = listed.find((robot) => robotNameMatches(robot.name, policy.name));
  if (existing?.id !== undefined) {
    await client.request(
      {
        method: 'PUT',
        path: `/robots/${existing.id}`,
        body: {
          ...robotRequest(project, policy),
          id: existing.id,
          name: existing.name ?? policy.name,
        },
        signal: options.signal,
      },
      [200]
    );
  }
  if (
    existing?.id !== undefined &&
    robotCredentialIsCurrent(
      secret,
      options.registry,
      existing.name ?? policy.name,
      existing.expires_at
    )
  ) {
    return {
      name: existing.name ?? policy.name,
      id: existing.id,
      secretName: policy.secretName,
      access: policy.access,
    };
  }

  let robot: HarborRobotResponse;
  if (existing?.id !== undefined) {
    const refreshed = await client.request<HarborRobotResponse>(
      {
        method: 'PATCH',
        path: `/robots/${existing.id}`,
        body: {},
        signal: options.signal,
      },
      [200]
    );
    robot = { ...existing, ...refreshed.body };
  } else {
    const created = await client.request<HarborRobotResponse>(
      {
        method: 'POST',
        path: '/robots',
        body: robotRequest(project, policy),
        signal: options.signal,
      },
      [201]
    );
    robot = created.body ?? {};
  }

  const robotId = robot.id;
  if (!Number.isInteger(robotId) || !robot.name || !robot.secret) {
    throw new HarborApiError(
      'Harbor robot response was missing its ID, username, or one-time secret.',
      200,
      existing ? `/robots/${existing.id}` : '/robots'
    );
  }
  await store.upsertSecret(
    dockerConfigSecret(
      secretNamespace,
      policy.secretName,
      options.registry,
      robot.name,
      robot.secret,
      project,
      policy.access
    )
  );
  return {
    name: robot.name,
    id: robotId as number,
    secretName: policy.secretName,
    access: policy.access,
  };
}

async function listHarborResources<T>(
  client: HarborApiClient,
  path: string,
  signal: AbortSignal | undefined
): Promise<T[]> {
  const resources: T[] = [];
  const pageSize = 100;
  const maxPages = 20;
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await client.request<T[]>(
      { method: 'GET', path: `${path}${separator}page=${page}&page_size=${pageSize}`, signal },
      [200]
    );
    const items = response.body ?? [];
    resources.push(...items);
    const totalHeader = response.headers['x-total-count'] ?? response.headers['X-Total-Count'];
    const total = Number(Array.isArray(totalHeader) ? totalHeader[0] : totalHeader);
    if (items.length < pageSize || (Number.isFinite(total) && resources.length >= total))
      return resources;
  }
  throw new HarborApiError(
    `Harbor API ${path} exceeded the bounded ${maxPages * pageSize}-item reconciliation limit.`,
    undefined,
    path
  );
}

function robotCredentialIsCurrent(
  secret: V1Secret | undefined,
  registry: string,
  robotName: string,
  expiresAt: number | undefined
): boolean {
  if (
    expiresAt !== undefined &&
    expiresAt !== -1 &&
    expiresAt <= Math.floor(Date.now() / 1_000) + 86_400
  ) {
    return false;
  }
  const encoded = secret?.data?.['.dockerconfigjson'];
  if (!encoded) return false;
  try {
    const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      auths?: Record<string, { username?: string; password?: string; auth?: string }>;
    };
    const credential = config.auths?.[registryHost(registry)];
    return credential?.username === robotName && Boolean(credential.password || credential.auth);
  } catch {
    return false;
  }
}

function robotRequest(project: string, policy: HarborRobotPolicy): Record<string, unknown> {
  const access = [{ resource: 'repository', action: 'pull', effect: 'allow' }];
  if (policy.access === 'push') {
    access.push({ resource: 'repository', action: 'push', effect: 'allow' });
  }
  return {
    name: policy.name,
    description: policy.description ?? `TypeKro-managed ${policy.access} robot for ${project}`,
    level: 'project',
    disable: false,
    duration: policy.durationDays ?? -1,
    permissions: [{ kind: 'project', namespace: project, access }],
  };
}

function dockerConfigSecret(
  namespace: string,
  name: string,
  registry: string,
  username: string,
  password: string,
  project: string,
  access: 'pull' | 'push'
): V1Secret {
  const host = registryHost(registry);
  const config = JSON.stringify({
    auths: {
      [host]: {
        username,
        password,
        auth: Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
      },
    },
  });
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'harbor',
        'app.kubernetes.io/component': `${access}-robot`,
        'app.kubernetes.io/managed-by': 'typekro',
        'typekro.dev/harbor-project': project,
      },
    },
    type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(config, 'utf8').toString('base64') },
  };
}

function createNodeHarborApiTransport(options: HarborApiClientOptions): HarborApiTransport {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('Harbor API endpoint must use https:// or http://.');
  }
  if (endpoint.protocol === 'http:' && !options.allowPlainHttp) {
    throw new Error(
      'Harbor API refuses to send Basic credentials over plain HTTP. ' +
        'Use HTTPS or set allowPlainHttp only for a trusted development endpoint.'
    );
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async request<T>(request: HarborApiTransportRequest) {
      if (request.signal?.aborted) throw new Error('Harbor API request was cancelled.');
      const credential = await options.credentialProvider(request.signal);
      if (request.signal?.aborted) throw new Error('Harbor API request was cancelled.');
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      const target = new URL(`/api/v2.0${request.path}`, endpoint);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(
          `${credential.username}:${credential.password}`,
          'utf8'
        ).toString('base64')}`,
        'X-Is-Resource-Name': 'true',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }
      return await new Promise<HarborApiTransportResponse<T>>((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        const outgoing = transport.request(
          target,
          {
            method: request.method,
            headers,
            ...(target.protocol === 'https:'
              ? {
                  ca: options.ca,
                  rejectUnauthorized: options.rejectUnauthorized ?? true,
                }
              : {}),
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            incoming.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 2 * 1024 * 1024) {
                outgoing.destroy(new Error('Harbor API response exceeded the 2 MiB limit.'));
                return;
              }
              chunks.push(chunk);
            });
            incoming.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let parsed: T | undefined;
              if (raw) {
                try {
                  parsed = JSON.parse(raw) as T;
                } catch {
                  parsed = undefined;
                }
              }
              resolve({
                status: incoming.statusCode ?? 0,
                body: parsed,
                headers: incoming.headers,
              });
            });
          }
        );
        const timeout = setTimeout(() => {
          outgoing.destroy(new Error(`Harbor API request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        const onAbort = () => outgoing.destroy(new Error('Harbor API request was cancelled.'));
        request.signal?.addEventListener('abort', onAbort, { once: true });
        outgoing.on('error', reject);
        outgoing.on('close', () => {
          clearTimeout(timeout);
          request.signal?.removeEventListener('abort', onAbort);
        });
        if (body !== undefined) outgoing.write(body);
        outgoing.end();
      });
    },
  };
}

function registryHost(value: string): string {
  return new URL(value.includes('://') ? value : `https://${value}`).host;
}

function robotNameMatches(actual: string | undefined, desired: string): boolean {
  return (
    actual === desired ||
    actual?.endsWith(`$${desired}`) === true ||
    actual?.endsWith(`+${desired}`) === true
  );
}

function validateProjectName(value: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid Harbor project name ${JSON.stringify(value)}.`);
  }
}

function validateRobotName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid Harbor robot name ${JSON.stringify(value)}.`);
  }
}
