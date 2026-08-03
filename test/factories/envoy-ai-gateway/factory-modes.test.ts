import { loadAll } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  envoyAIAcceptedReadinessEvaluator,
  envoyAIGatewayPlatformBootstrap,
  envoyGatewayPolicyReadinessEvaluator,
  envoyGatewayReadinessEvaluator,
  envoyMCPRoute,
  makeEnvoyAIGateway,
  makeEnvoyAIGatewayPlatformInstallation,
} from '../../../src/factories/envoy-ai-gateway/index.js';

type YamlDocument = Record<string, unknown>;

function documents(yaml: string): YamlDocument[] {
  return loadAll(yaml).filter(
    (document): document is YamlDocument =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
}

function record(value: unknown): YamlDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a YAML object, received ${String(value)}`);
  }
  return value as YamlDocument;
}

function rgd(yaml: string, name: string): YamlDocument {
  const result = documents(yaml).find((document) => {
    const metadata = record(document.metadata);
    return document.kind === 'ResourceGraphDefinition' && metadata.name === name;
  });
  if (!result) throw new Error(`Missing ResourceGraphDefinition ${name}`);
  return result;
}

function localGateway() {
  return makeEnvoyAIGateway({
    profile: 'development',
    providers: [
      {
        name: 'local',
        kind: 'openai-compatible',
        hostname: 'mock-ai.default.svc.cluster.local',
        port: 8080,
        tls: false,
      },
    ],
    models: [
      {
        model: 'fast',
        targets: [{ provider: 'local', model: 'mock-fast' }],
      },
    ],
  });
}

describe('Envoy AI Gateway integration', () => {
  test('requires current accepted conditions in direct readiness', () => {
    expect(
      envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: {
          conditions: [
            {
              type: 'Accepted',
              status: 'True',
              observedGeneration: 1,
            },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'Reconciling' });

    expect(
      envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: {
          conditions: [
            {
              type: 'Accepted',
              status: 'True',
              observedGeneration: 2,
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });

    expect(
      envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: {
          conditions: [{ type: 'Accepted', status: 'True' }],
        },
      })
    ).toMatchObject({ ready: true });

    expect(
      envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: {
          conditions: [
            {
              type: 'NotAccepted',
              status: 'True',
              observedGeneration: 1,
            },
            {
              type: 'Accepted',
              status: 'True',
              observedGeneration: 2,
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });
  });

  test('requires both current Gateway acceptance and programming', () => {
    const stale = envoyGatewayReadinessEvaluator({
      metadata: { generation: 4 },
      status: {
        conditions: [
          { type: 'Accepted', status: 'True', observedGeneration: 4 },
          { type: 'Programmed', status: 'True', observedGeneration: 3 },
        ],
      },
    });
    const current = envoyGatewayReadinessEvaluator({
      metadata: { generation: 4 },
      status: {
        conditions: [
          { type: 'Accepted', status: 'True', observedGeneration: 4 },
          { type: 'Programmed', status: 'True', observedGeneration: 4 },
        ],
      },
    });

    expect(stale.ready).toBe(false);
    expect(current).toMatchObject({
      ready: true,
      reason: 'GatewayProgrammed',
    });
  });

  test('requires current policy acceptance and fails fast on rejected policy status', () => {
    expect(
      envoyGatewayPolicyReadinessEvaluator({
        metadata: { generation: 3 },
        status: {
          ancestors: [
            {
              controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
              conditions: [
                {
                  type: 'Accepted',
                  status: 'False',
                  reason: 'TargetNotFound',
                  observedGeneration: 3,
                },
              ],
            },
          ],
        },
      })
    ).toMatchObject({
      ready: false,
      terminal: true,
      reason: 'TargetNotFound',
    });

    expect(
      envoyGatewayPolicyReadinessEvaluator({
        metadata: { generation: 3 },
        status: {
          ancestors: [
            {
              controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
              conditions: [
                {
                  type: 'Accepted',
                  status: 'False',
                  observedGeneration: 2,
                },
                {
                  type: 'Accepted',
                  status: 'True',
                  observedGeneration: 3,
                },
              ],
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });

    expect(
      envoyGatewayPolicyReadinessEvaluator({
        metadata: { generation: 3 },
        status: {
          ancestors: [
            {
              controllerName: 'unrelated.example/controller',
              conditions: [
                {
                  type: 'Accepted',
                  status: 'True',
                  observedGeneration: 3,
                },
              ],
            },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'Reconciling' });
  });

  test('renders a complete direct gateway with desired platform configuration', () => {
    const yaml = localGateway().factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'research',
      namespace: 'research-ai',
      lifecycle: 'owned',
      listenerPort: 8080,
    });

    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: GatewayConfig');
    expect(yaml).toContain('value: v0.6.0');
    expect(yaml).toContain('kind: Gateway');
    expect(yaml).toContain('gatewayClassName: envoy-ai-gateway');
    expect(yaml).toContain('kind: Backend');
    expect(yaml).toContain('hostname: mock-ai.default.svc.cluster.local');
    expect(yaml).toContain('kind: AIServiceBackend');
    expect(yaml).toContain('modelNameOverride: mock-fast');
    expect(yaml).toContain('kind: AIGatewayRoute');
    expect(yaml).toContain('kind: BackendTrafficPolicy');
    expect(yaml).not.toContain('__KUBERNETES_REF__');
    expect(yaml).not.toContain('__typekro');
  });

  test('gates route and provider status on the observed generation when available', () => {
    const yaml = localGateway().factory('kro', { namespace: 'typekro-system' }).toYaml();
    const gateway = rgd(yaml, 'envoy-ai-gateway');
    const status = record(record(gateway.spec).schema).status;
    const serializedStatus = JSON.stringify(status);

    expect(serializedStatus).toContain(
      'has(c.observedGeneration) ? c.observedGeneration == route.metadata.generation : true'
    );
    expect(serializedStatus).toMatch(
      /has\(c\.observedGeneration\) \? c\.observedGeneration == providerLocal[a-f0-9]{10}AIServiceBackend\.metadata\.generation : true/u
    );
  });

  test('keeps distinct hyphenated provider names as distinct graph resources', () => {
    const gateway = makeEnvoyAIGateway({
      profile: 'development',
      providers: [
        {
          name: 'a-b',
          kind: 'openai-compatible',
          hostname: 'first.default.svc.cluster.local',
          tls: false,
        },
        {
          name: 'a--b',
          kind: 'openai-compatible',
          hostname: 'second.default.svc.cluster.local',
          tls: false,
        },
      ],
      models: [
        {
          model: 'fast',
          targets: [
            { provider: 'a-b', model: 'first' },
            { provider: 'a--b', model: 'second' },
          ],
        },
      ],
    });
    const yaml = gateway.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'collision-proof',
      namespace: 'application-owned',
      lifecycle: 'external',
    });
    const rendered = documents(yaml);

    expect(rendered.filter((document) => document.kind === 'Backend')).toHaveLength(2);
    expect(rendered.filter((document) => document.kind === 'AIServiceBackend')).toHaveLength(2);
    expect(yaml).toContain('first.default.svc.cluster.local');
    expect(yaml).toContain('second.default.svc.cluster.local');
  });

  test('rejects ports outside the Kubernetes service-port range', () => {
    expect(() =>
      makeEnvoyAIGateway({
        profile: 'development',
        providers: [
          {
            name: 'invalid',
            kind: 'openai-compatible',
            hostname: 'invalid.default.svc.cluster.local',
            port: 70_000,
            tls: false,
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'invalid' }] }],
      })
    ).toThrow(/1 through 65535/);

    expect(() =>
      localGateway().factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'invalid-listener',
        namespace: 'application-owned',
        lifecycle: 'external',
        listenerPort: 70_000,
      })
    ).toThrow();
  });

  test('supports externally owned application namespaces', () => {
    const yaml = localGateway().factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'external',
      namespace: 'application-owned',
      lifecycle: 'external',
    });

    expect(
      documents(yaml).some(
        (document) =>
          document.kind === 'Namespace' && record(document.metadata).name === 'application-owned'
      )
    ).toBe(false);
    expect(yaml).toContain('namespace: application-owned');
  });

  test('renders provider credentials, TLS, weighting, priority, and fallback', () => {
    const gateway = makeEnvoyAIGateway({
      profile: 'development',
      providers: [
        {
          name: 'openai',
          kind: 'openai',
          credential: { name: 'openai-key' },
        },
        {
          name: 'anthropic',
          kind: 'anthropic',
          credential: { name: 'anthropic-key', namespace: 'credentials' },
        },
      ],
      models: [
        {
          model: 'reasoning',
          targets: [
            { provider: 'anthropic', model: 'claude', priority: 0, weight: 100 },
            { provider: 'openai', model: 'gpt', priority: 1, weight: 100 },
          ],
        },
      ],
    });
    const yaml = gateway.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'secure',
      namespace: 'secure-ai',
      lifecycle: 'external',
    });

    expect(yaml).toContain('type: APIKey');
    expect(yaml).toContain('name: openai-key');
    expect(yaml).toContain('type: AnthropicAPIKey');
    expect(yaml).toContain('name: anthropic-key');
    expect(yaml).toContain('namespace: credentials');
    expect(yaml).toContain('kind: BackendTLSPolicy');
    expect(yaml).toContain('wellKnownCACertificates: System');
    expect(yaml).toContain('modelNameOverride: claude');
    expect(yaml).toContain('priority: 1');
    expect(yaml).toContain('numRetries: 2');
  });

  test('renders token accounting and rate limiting without leaking provider details', () => {
    const gateway = makeEnvoyAIGateway({
      profile: 'development',
      providers: [
        {
          name: 'local',
          kind: 'openai-compatible',
          hostname: 'mock-ai.default.svc.cluster.local',
          tls: false,
        },
      ],
      models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
      rateLimit: {
        redisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
        rules: [
          {
            identityHeader: 'x-applik8s-principal',
            requests: 100_000,
            unit: 'Hour',
            cost: 'total-tokens',
          },
          {
            requests: 100,
            unit: 'Minute',
            cost: 'request',
          },
        ],
      },
    });
    const factory = gateway.factory('kro', { namespace: 'typekro-system' });
    const yaml = `${factory.toYaml()}\n---\n${factory.toYaml({
      name: 'limited',
      namespace: 'limited-ai',
      lifecycle: 'owned',
    })}`;

    expect(yaml).toContain('globalLLMRequestCosts:');
    expect(yaml).toContain('metadataKey: llm_input_token');
    expect(yaml).toContain('metadataKey: llm_total_token');
    expect(yaml).toContain('name: x-applik8s-principal');
    expect(yaml).toContain('requests: 100000');
    expect(yaml).toContain('namespace: io.envoy.ai_gateway');
    expect(yaml).toContain('key: llm_total_token');
    expect(yaml).toContain('valkey.valkey-system.svc.cluster.local:6379');
    expect(yaml).toContain('configurationDigest: fnv64:');
  });

  test('binds token rate limits to the configured request-cost metadata key', () => {
    const gateway = makeEnvoyAIGateway({
      profile: 'development',
      providers: [
        {
          name: 'local',
          kind: 'openai-compatible',
          hostname: 'mock-ai.default.svc.cluster.local',
          tls: false,
        },
      ],
      models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
      requestCosts: [{ metadataKey: 'tenant_total_tokens', type: 'TotalToken' }],
      rateLimit: {
        redisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
        rules: [{ requests: 100_000, unit: 'Hour', cost: 'total-tokens' }],
      },
    });

    expect(gateway.factory('kro', { namespace: 'typekro-system' }).toYaml()).toContain(
      'key: tenant_total_tokens'
    );
  });

  test('defaults omitted rate-limit costs to total token accounting', () => {
    const gateway = makeEnvoyAIGateway({
      profile: 'development',
      providers: [
        {
          name: 'local',
          kind: 'openai-compatible',
          hostname: 'mock-ai.default.svc.cluster.local',
          tls: false,
        },
      ],
      models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
      rateLimit: {
        redisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
        rules: [{ requests: 100_000, unit: 'Hour' }],
      },
    });

    const yaml = gateway.factory('kro', { namespace: 'typekro-system' }).toYaml();
    expect(yaml).toContain('namespace: io.envoy.ai_gateway');
    expect(yaml).toContain('key: llm_total_token');
  });

  test('filters KRO policy readiness by the Envoy Gateway controller', () => {
    const yaml = localGateway().factory('kro', { namespace: 'typekro-system' }).toYaml();

    expect(yaml).toContain('a.controllerName == "gateway.envoyproxy.io/gatewayclass-controller"');
  });

  test('rejects token rate limits whose request-cost dimension was removed', () => {
    expect(() =>
      makeEnvoyAIGateway({
        profile: 'development',
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: 'mock-ai.default.svc.cluster.local',
            tls: false,
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
        requestCosts: [{ metadataKey: 'input_only', type: 'InputToken' }],
        rateLimit: {
          redisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
          rules: [{ requests: 100_000, unit: 'Hour', cost: 'total-tokens' }],
        },
      })
    ).toThrow('requires a matching requestCosts dimension');
  });

  test('exposes the reviewed v1beta1 MCPRoute resource seam', () => {
    const route = envoyMCPRoute({
      name: 'tools',
      namespace: 'agent-system',
      spec: {
        parentRefs: [
          {
            name: 'agents',
            kind: 'Gateway',
            group: 'gateway.networking.k8s.io',
          },
        ],
        path: '/mcp',
        backendRefs: [
          {
            name: 'research-tools',
            kind: 'Backend',
            group: 'gateway.envoyproxy.io',
            path: '/mcp',
            toolSelector: {
              include: ['search', 'observe'],
              excludeRegex: ['^admin_'],
            },
            securityPolicy: {
              apiKey: {
                secretRef: { name: 'research-tools-api-key' },
              },
            },
            forwardHeaders: [
              {
                name: 'x-applik8s-principal',
                backendHeader: 'x-principal-id',
              },
            ],
          },
        ],
      },
      id: 'toolsRoute',
    });

    expect(route.apiVersion).toBe('aigateway.envoyproxy.io/v1beta1');
    expect(route.kind).toBe('MCPRoute');
    expect(route.spec.backendRefs[0]).toMatchObject({
      name: 'research-tools',
      toolSelector: {
        include: ['search', 'observe'],
        excludeRegex: ['^admin_'],
      },
    });
  });

  test('keeps platform compatibility pins protected and caller values immutable', () => {
    const customValues = {
      config: {
        envoyGateway: {
          gateway: { controllerName: 'invalid.example/controller' },
          provider: { type: 'Custom' },
          extensionApis: {
            enableBackend: false,
            enableEnvoyPatchPolicy: false,
          },
          extensionManager: {
            service: {
              fqdn: {
                hostname: 'invalid.example',
                port: 9999,
              },
            },
          },
        },
      },
      deployment: { replicas: 3 },
    };
    const before = structuredClone(customValues);
    const platform = makeEnvoyAIGatewayPlatformInstallation({
      profile: 'production',
      mcpSessionEncryptionSeedSecret: {
        name: 'envoy-ai-gateway-mcp-seed',
      },
      envoyGatewayValues: customValues,
      aiGatewayValues: {
        extProc: { enableRedaction: false },
      },
    });
    const yaml = platform.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'envoy-ai',
    });

    expect(customValues).toEqual(before);
    expect(yaml).toContain('replicas: 3');
    expect(yaml).toContain('controllerName: gateway.envoyproxy.io/gatewayclass-controller');
    expect(yaml).toContain('type: Kubernetes');
    expect(yaml).toContain('enableBackend: true');
    expect(yaml).toContain('enableEnvoyPatchPolicy: true');
    expect(yaml).toContain(
      'hostname: ai-gateway-controller.envoy-ai-gateway-system.svc.cluster.local'
    );
    expect(yaml).toContain('port: 1063');
    expect(yaml).toContain('enableRedaction: true');
    expect(yaml).toContain('name: envoy-ai-gateway-mcp-seed');
    expect(yaml).toContain('valuesKey: seed');
    expect(yaml).toContain('targetPath: controller.mcp.sessionEncryption.seed');
    expect(yaml).not.toContain('default-insecure-seed');
    expect(yaml).not.toContain('enableRedaction: false');
    expect(yaml).not.toContain('invalid.example/controller');
    expect(yaml).not.toContain('hostname: invalid.example');
  });

  test('fails closed when production MCP session encryption has no Secret source', () => {
    expect(() =>
      makeEnvoyAIGatewayPlatformInstallation({
        profile: 'production',
      })
    ).toThrow(/mcpSessionEncryptionSeedSecret/);

    expect(() =>
      makeEnvoyAIGateway({
        profile: 'production',
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: 'mock-ai.default.svc.cluster.local',
            tls: false,
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
      })
    ).toThrow(/mcpSessionEncryptionSeedSecret/);

    expect(() =>
      makeEnvoyAIGatewayPlatformInstallation({
        profile: 'production',
        mcpSessionEncryptionSeedSecret: { name: 'managed-seed' },
        aiGatewayValues: {
          controller: {
            mcp: {
              sessionEncryption: {
                seed: 'inline-secret',
              },
            },
          },
        },
      })
    ).toThrow(/must come from mcpSessionEncryptionSeedSecret/);
  });

  test('supports externally owned platform namespaces for parent deployment graphs', () => {
    const platform = makeEnvoyAIGatewayPlatformInstallation({
      profile: 'production',
      namespaceOwnership: 'external',
      mcpSessionEncryptionSeedSecret: { name: 'managed-seed' },
    });
    const yaml = platform.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'envoy-ai',
      namespaceOwnership: 'external',
    });

    expect(
      documents(yaml).filter((document) => document.kind === 'Namespace')
    ).toEqual([]);
    expect(yaml).toContain('namespace: envoy-gateway-system');
    expect(yaml).toContain('namespace: envoy-ai-gateway-system');
  });

  test('rejects a nested platform profile that weakens or conflicts with the gateway profile', () => {
    expect(() =>
      makeEnvoyAIGateway({
        profile: 'production',
        platform: {
          profile: 'development',
          mcpSessionEncryptionSeedSecret: { name: 'managed-seed' },
        },
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: 'mock-ai.default.svc.cluster.local',
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
      })
    ).toThrow(/profile production conflicts with nested platform profile development/);
  });

  test('keeps singleton Redis topology out of the runtime installation spec', () => {
    const platform = makeEnvoyAIGatewayPlatformInstallation({
      profile: 'production',
      rateLimitRedisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
      mcpSessionEncryptionSeedSecret: { name: 'managed-seed' },
    });
    const yaml = platform.factory('kro', { namespace: 'typekro-system' }).toYaml();
    const definition = rgd(yaml, 'envoy-ai-gateway-platform-installation');
    const schema = record(record(definition.spec).schema);

    expect(record(schema.spec)).not.toHaveProperty('rateLimitRedisUrl');
    expect(yaml).toContain('valkey.valkey-system.svc.cluster.local:6379');
    expect(yaml).toContain('targetPath: controller.mcp.sessionEncryption.seed');
  });

  test('keeps shared platform ownership outside application graphs', () => {
    const yaml = envoyAIGatewayPlatformBootstrap
      .factory('kro', { namespace: 'typekro-system' })
      .toYaml();
    const bootstrap = rgd(yaml, 'envoy-ai-gateway-platform-bootstrap');
    const resources = record(bootstrap.spec).resources;

    expect(Array.isArray(resources)).toBe(true);
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources)).toContain('"externalRef"');
    expect(JSON.stringify(resources)).toContain('"EnvoyAIGatewayPlatformInstallation"');
    expect(JSON.stringify(resources)).toContain('"kind":"GatewayClass"');
    expect(JSON.stringify(resources)).toContain('"includeWhen"');
    expect(JSON.stringify(resources)).not.toContain('"HelmRelease"');
  });

  test('serializes the complete KRO status and v1beta1 resource graph', () => {
    const yaml = localGateway().factory('kro', { namespace: 'typekro-system' }).toYaml();
    const gateway = rgd(yaml, 'envoy-ai-gateway');
    const spec = record(gateway.spec);
    const schema = record(spec.schema);
    const status = record(schema.status);
    const schemaSpec = record(schema.spec);
    const resources = JSON.stringify(spec.resources);

    expect(resources).toContain('"apiVersion":"aigateway.envoyproxy.io/v1beta1"');
    expect(resources).toContain('"kind":"GatewayConfig"');
    expect(resources).toContain('"kind":"AIServiceBackend"');
    expect(resources).toContain('"kind":"AIGatewayRoute"');
    expect(resources).toContain('"kind":"BackendTrafficPolicy"');
    expect(resources).toContain('"gatewayClassName":"envoy-ai-gateway"');
    expect(resources).toContain('"value":"v0.6.0"');
    expect(status).toHaveProperty('ready');
    expect(status).toHaveProperty('failed');
    expect(status).toHaveProperty('phase');
    expect(status).toHaveProperty('endpoint');
    expect(status).toHaveProperty('gatewayClassName', '${gatewayContract.data.gatewayClassName}');
    expect(status).toHaveProperty('providerCount', '${int(gatewayContract.data.providerCount)}');
    expect(status).toHaveProperty('acceptedProviderCount');
    expect(status).toHaveProperty('routeAccepted');
    expect(status).toHaveProperty('gatewayProgrammed');
    expect(String(status.endpoint)).toContain('size(gateway.status.addresses)');
    expect(String(status.endpoint)).not.toContain('.size()');
    expect(status).toHaveProperty('aiGatewayVersion', '${gatewayContract.data.aiGatewayVersion}');
    expect(schemaSpec).toHaveProperty('listenerPort', 'integer | minimum=1 maximum=65535');
    expect(String(status.ready)).toContain('observedGeneration');
    expect(String(status.failed)).toContain('observedGeneration');
    expect(String(status.ready)).toContain('retryPolicy.status.ancestors');
    expect(String(status.failed)).toContain('retryPolicy.status.ancestors');
  });

  test('rejects invalid provider topology before rendering either mode', () => {
    expect(() =>
      makeEnvoyAIGateway({
        providers: [],
        models: [{ model: 'fast', targets: [{ provider: 'missing' }] }],
      })
    ).toThrow('requires at least one provider');
    expect(() =>
      makeEnvoyAIGateway({
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: 'localhost',
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'missing' }] }],
      })
    ).toThrow('references unknown provider missing');
    expect(() =>
      makeEnvoyAIGateway({
        providers: [
          {
            name: 'Not Valid',
            kind: 'openai-compatible',
            hostname: 'localhost',
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'Not Valid' }] }],
      })
    ).toThrow('must be a DNS-1123 label');
    expect(() =>
      makeEnvoyAIGateway({
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: 'localhost',
          },
        ],
        models: [{ model: 'fast', targets: [{ provider: 'local' }] }],
        rateLimit: {
          redisUrl: 'redis://valkey:6379',
          rules: [{ requests: 100, unit: 'Minute' }],
        },
      })
    ).toThrow('without a URL scheme');
  });

  test('hoists owned KRO namespaces outside the RGD lifecycle', () => {
    const gatewayFactory = localGateway().factory('kro', {
      namespace: 'self-owned',
    });
    const yaml = gatewayFactory.toYaml({
      name: 'self-owned',
      namespace: 'self-owned',
      lifecycle: 'owned',
    });
    const instance = documents(yaml).find((document) => document.kind === 'EnvoyAIGateway');
    const ownedNamespace = documents(yaml).find(
      (document) => document.kind === 'Namespace' && record(document.metadata).name === 'self-owned'
    );

    expect(instance).toBeDefined();
    expect(record(instance?.metadata).namespace).toBe('self-owned');
    expect(record(instance?.metadata).annotations).toMatchObject({
      'typekro.io/hoisted-namespaces': '["self-owned"]',
    });
    expect(ownedNamespace).toBeDefined();
    expect(record(ownedNamespace?.metadata).annotations).toMatchObject({
      'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false',
      'kustomize.toolkit.fluxcd.io/prune': 'disabled',
    });
    const gatewayRgd = rgd(gatewayFactory.toYaml(), 'envoy-ai-gateway');
    expect(JSON.stringify(record(gatewayRgd.spec).resources)).not.toContain('"kind":"Namespace"');
  });
});
