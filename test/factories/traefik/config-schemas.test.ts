/**
 * Traefik CONFIGURATION schema tests (no cluster).
 *
 * `schemas.test.ts` covers the CRD spec schemas; this file covers the schemas
 * the exported `*Config` types are inferred from — the factory-facing surface
 * a caller types by hand. Two things are being protected:
 *
 *  - the constraints these schemas add over a bare `string`/`number`, each of
 *    which stands for a real failure mode (a malformed Flux interval is
 *    accepted at admission and then never reconciles; a `forwardAuth` with no
 *    response-header allowlist leaks whatever the authorizer returns);
 *  - the fact that the config types and their schemas cannot drift, which is
 *    proven by feeding a schema-validated object straight into the factory.
 *
 * The factories deliberately do NOT run these schemas over their input: inside
 * a composition `name` may be a `KubernetesRef` proxy rather than a string, and
 * every constraint here would reject it. The `Composable` probe at the bottom
 * is what pins that half.
 */
import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  traefikGatewayClass,
  traefikHelmRelease,
  traefikHelmRepository,
} from '../../../src/factories/traefik/index.js';
import {
  traefikBufferingMiddleware,
  traefikChainMiddleware,
  traefikForwardAuthMiddleware,
  traefikRedirectSchemeMiddleware,
} from '../../../src/factories/traefik/resources/middleware.js';
import {
  type TraefikChainMiddlewareConfig,
  TraefikChainMiddlewareConfigSchema,
  type TraefikForwardAuthMiddlewareConfig,
  TraefikForwardAuthMiddlewareConfigSchema,
  TraefikGatewayClassConfigSchema,
  type TraefikHelmReleaseConfig,
  TraefikHelmReleaseConfigSchema,
  type TraefikHelmRepositoryConfig,
  TraefikHelmRepositoryConfigSchema,
  TraefikInFlightReqMiddlewareConfigSchema,
  TraefikPluginChartConfigSchema,
  TraefikRateLimitMiddlewareConfigSchema,
  TraefikRedirectSchemeMiddlewareConfigSchema,
  TraefikResourceMetadataSchema,
} from '../../../src/factories/traefik/types.js';

function rejects(result: unknown): boolean {
  return result instanceof type.errors;
}

describe('Traefik resource metadata schema', () => {
  it('accepts the identity every namespaced CRD factory takes', () => {
    const result = TraefikResourceMetadataSchema({
      name: 'orders-api-authz',
      namespace: 'edge',
      labels: { 'example.com/team': 'platform' },
      annotations: { 'example.com/owner': 'platform' },
      id: 'ordersApiAuthz',
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects a name the API server would reject', () => {
    // Object names are DNS subdomains: lowercase, no underscores.
    expect(rejects(TraefikResourceMetadataSchema({ name: 'Orders_API', namespace: 'edge' }))).toBe(
      true
    );
  });

  it('rejects a namespace longer than a DNS label', () => {
    expect(
      rejects(TraefikResourceMetadataSchema({ name: 'orders-api', namespace: 'e'.repeat(64) }))
    ).toBe(true);
  });

  it('requires a namespace, because every one of these kinds is namespaced', () => {
    expect(rejects(TraefikResourceMetadataSchema({ name: 'orders-api' }))).toBe(true);
  });
});

describe('Helm configuration schemas', () => {
  it('accepts a repository config carrying only a name', () => {
    expect(rejects(TraefikHelmRepositoryConfigSchema({ name: 'traefik-repo' }))).toBe(false);
  });

  it('accepts every Go duration form Flux parses', () => {
    for (const interval of ['1h', '30s', '5m', '1h30m', '1500ms']) {
      expect(
        rejects(TraefikHelmRepositoryConfigSchema({ name: 'traefik-repo', interval })),
        interval
      ).toBe(false);
    }
  });

  it('rejects an interval Flux would refuse to parse', () => {
    // Flux accepts the HelmRepository and then never reconciles it, which in
    // the cluster reads as "Flux is broken" rather than as a typo.
    for (const interval of ['1 hour', '1hour', 'hourly', '60']) {
      expect(
        rejects(TraefikHelmRepositoryConfigSchema({ name: 'traefik-repo', interval })),
        interval
      ).toBe(true);
    }
  });

  it('accepts the three CRD policies and rejects anything else', () => {
    for (const crds of ['Skip', 'Create', 'CreateReplace']) {
      expect(rejects(TraefikHelmReleaseConfigSchema({ name: 'traefik', crds })), crds).toBe(false);
    }
    expect(rejects(TraefikHelmReleaseConfigSchema({ name: 'traefik', crds: 'Replace' }))).toBe(
      true
    );
  });

  it('rejects a release timeout that is not a Go duration', () => {
    expect(
      rejects(TraefikHelmReleaseConfigSchema({ name: 'traefik', timeout: '10 minutes' }))
    ).toBe(true);
  });

  it('builds the Flux objects from schema-validated configs', () => {
    // The schema and the factory cannot drift while this passes: the object
    // handed to the factory is the schema's own output, not a literal.
    const repositoryConfig = TraefikHelmRepositoryConfigSchema.assert({
      name: 'traefik-repo',
      namespace: 'flux-system',
      interval: '1h',
      id: 'repository',
    }) as TraefikHelmRepositoryConfig;
    const releaseConfig = TraefikHelmReleaseConfigSchema.assert({
      name: 'traefik',
      targetNamespace: 'edge',
      repositoryName: 'traefik-repo',
      crds: 'CreateReplace',
      timeout: '10m',
      id: 'release',
    }) as TraefikHelmReleaseConfig;

    const repository = traefikHelmRepository(repositoryConfig);
    const release = traefikHelmRelease(releaseConfig);

    expect(repository.kind).toBe('HelmRepository');
    expect(repository.spec?.interval).toBe('1h');
    expect(release.kind).toBe('HelmRelease');
    expect(release.spec?.targetNamespace).toBe('edge');
    expect(release.spec?.install?.crds).toBe('CreateReplace');
    expect(release.spec?.upgrade?.crds).toBe('CreateReplace');
  });

  it('keeps values typed as graph-aware chart values, not as schema output', () => {
    // The documented exception: `values` is `TypeKroChartValues<...>`, a union
    // with build-time ref/CEL proxy types, so it is declared on the type rather
    // than in the schema. What matters is that it still type-checks and still
    // reaches Flux.
    const release = traefikHelmRelease({
      name: 'traefik',
      values: { api: { dashboard: false }, service: { enabled: false } },
      id: 'release',
    });

    expect(release.spec?.values).toEqual({
      api: { dashboard: false },
      service: { enabled: false },
    });
  });

  it('keeps experimental plugin declarations an opaque map', () => {
    expect(
      rejects(TraefikPluginChartConfigSchema({ 'my-plugin': { moduleName: 'example.com/plugin' } }))
    ).toBe(false);
  });
});

describe('Middleware builder configuration schemas', () => {
  it('requires an explicit authResponseHeaders allowlist', () => {
    // Stricter than the CRD on purpose: an implicit "copy everything" lets an
    // authorizer bug leak headers to the upstream.
    expect(
      rejects(
        TraefikForwardAuthMiddlewareConfigSchema({
          name: 'orders-api-authz',
          namespace: 'edge',
          address: 'http://authorizer.edge.svc.cluster.local:8080/authorize',
        })
      )
    ).toBe(true);

    const withAllowlist = TraefikForwardAuthMiddlewareConfigSchema({
      name: 'orders-api-authz',
      namespace: 'edge',
      address: 'http://authorizer.edge.svc.cluster.local:8080/authorize',
      authResponseHeaders: ['X-Edge-Principal'],
    });

    expect(rejects(withAllowlist)).toBe(false);
  });

  it('rejects an empty authorizer address', () => {
    expect(
      rejects(
        TraefikForwardAuthMiddlewareConfigSchema({
          name: 'orders-api-authz',
          namespace: 'edge',
          address: '',
          authResponseHeaders: ['X-Edge-Principal'],
        })
      )
    ).toBe(true);
  });

  it('rejects a rate limit keyed two ways at once', () => {
    // `requestHeaderName` is shorthand for `sourceCriterion.requestHeaderName`.
    // Setting both is not a merge: the builder keeps `sourceCriterion` and
    // silently drops the header name.
    const both = TraefikRateLimitMiddlewareConfigSchema({
      name: 'orders-api-rate-limit',
      namespace: 'edge',
      average: 50,
      burst: 100,
      requestHeaderName: 'X-Edge-Principal',
      sourceCriterion: { requestHost: true },
    });

    expect(rejects(both)).toBe(true);
    expect(String(both)).toContain('not both');
  });

  it('accepts a rate limit keyed either way on its own', () => {
    const base = { name: 'orders-api-rate-limit', namespace: 'edge', average: 50, burst: 100 };

    expect(
      rejects(
        TraefikRateLimitMiddlewareConfigSchema({ ...base, requestHeaderName: 'X-Edge-Principal' })
      )
    ).toBe(false);
    expect(
      rejects(
        TraefikRateLimitMiddlewareConfigSchema({
          ...base,
          sourceCriterion: { ipStrategy: { depth: 1 } },
        })
      )
    ).toBe(false);
    expect(rejects(TraefikRateLimitMiddlewareConfigSchema(base))).toBe(false);
  });

  it('applies the same exclusive-key rule to inFlightReq', () => {
    expect(
      rejects(
        TraefikInFlightReqMiddlewareConfigSchema({
          name: 'orders-api-concurrency',
          namespace: 'edge',
          amount: 20,
          requestHeaderName: 'X-Edge-Customer',
          sourceCriterion: { requestHost: true },
        })
      )
    ).toBe(true);
  });

  it('accepts a shared Redis backend on a rate limit', () => {
    const result = TraefikRateLimitMiddlewareConfigSchema({
      name: 'orders-api-rate-limit',
      namespace: 'edge',
      average: 50,
      burst: 100,
      redis: { endpoints: ['valkey-primary.edge.svc.cluster.local:6379'], db: 3 },
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects a redirect scheme the middleware cannot emit', () => {
    const base = { name: 'orders-api-redirect', namespace: 'edge' };

    expect(rejects(TraefikRedirectSchemeMiddlewareConfigSchema({ ...base, scheme: 'https' }))).toBe(
      false
    );
    expect(rejects(TraefikRedirectSchemeMiddlewareConfigSchema({ ...base, scheme: 'ftp' }))).toBe(
      true
    );
  });

  it('requires a name on every chained middleware reference', () => {
    const named = TraefikChainMiddlewareConfigSchema({
      name: 'orders-api-edge',
      namespace: 'edge',
      middlewares: [{ name: 'orders-api-authz' }, { name: 'orders-api-rate-limit' }],
    });
    const unnamed = TraefikChainMiddlewareConfigSchema({
      name: 'orders-api-edge',
      namespace: 'edge',
      middlewares: [{ namespace: 'edge' }],
    });

    expect(rejects(named)).toBe(false);
    expect(rejects(unnamed)).toBe(true);
  });

  it('builds the middlewares from schema-validated configs', () => {
    const forwardAuth = TraefikForwardAuthMiddlewareConfigSchema.assert({
      name: 'orders-api-authz',
      namespace: 'edge',
      address: 'http://authorizer.edge.svc.cluster.local:8080/authorize',
      authResponseHeaders: ['X-Edge-Principal'],
      id: 'authz',
    }) as TraefikForwardAuthMiddlewareConfig;
    const chain = TraefikChainMiddlewareConfigSchema.assert({
      name: 'orders-api-edge',
      namespace: 'edge',
      middlewares: [{ name: 'orders-api-authz' }],
      id: 'chain',
    }) as TraefikChainMiddlewareConfig;

    // Read the specs back as plain data: `Enhanced<...>['spec']` is a magic
    // proxy type, so comparing it to a literal is a type error rather than a
    // value check.
    const authSpec = JSON.parse(JSON.stringify(traefikForwardAuthMiddleware(forwardAuth).spec));
    const chainSpec = JSON.parse(JSON.stringify(traefikChainMiddleware(chain).spec));

    expect(authSpec).toEqual({
      forwardAuth: {
        address: 'http://authorizer.edge.svc.cluster.local:8080/authorize',
        trustForwardHeader: false,
        authResponseHeaders: ['X-Edge-Principal'],
      },
    });
    expect(chainSpec).toEqual({ chain: { middlewares: [{ name: 'orders-api-authz' }] } });
  });
});

describe('GatewayClass configuration schema', () => {
  it('accepts a cluster-scoped identity plus a description', () => {
    expect(
      rejects(
        TraefikGatewayClassConfigSchema({
          name: 'traefik-edge',
          description: 'Edge class served by Traefik',
          id: 'traefikGatewayClass',
        })
      )
    ).toBe(false);
  });

  it('carries no namespace, because a GatewayClass is cluster-scoped', () => {
    const declared = TraefikGatewayClassConfigSchema.onUndeclaredKey('reject');

    expect(rejects(declared({ name: 'traefik-edge' }))).toBe(false);
    expect(rejects(declared({ name: 'traefik-edge', namespace: 'edge' }))).toBe(true);
  });
});

describe('Composable factory signatures', () => {
  it('builds the config-schema factories from optional composition spec fields', () => {
    // These factories' configs are now inferred rather than hand-written, so
    // this re-proves the `Composable<T>` half: a proxy-sourced optional field
    // still compiles, and the schema constraints do not run over a proxy.
    const edge = kubernetesComposition(
      {
        name: 'traefik-config-schema-probe',
        kind: 'TraefikConfigSchemaProbe',
        spec: type({
          name: 'string',
          namespace: 'string',
          'chartVersion?': 'string',
          'maxBodyBytes?': 'number',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        traefikHelmRepository({ name: `${spec.name}-repo`, id: 'repository' });
        traefikHelmRelease({
          name: spec.name,
          targetNamespace: spec.namespace,
          version: spec.chartVersion ?? '41.5.0',
          repositoryName: `${spec.name}-repo`,
          id: 'release',
        });
        traefikGatewayClass({ name: `${spec.name}-class`, id: 'gatewayClass' });
        traefikBufferingMiddleware({
          name: `${spec.name}-body-limit`,
          namespace: spec.namespace,
          buffering: { maxRequestBodyBytes: spec.maxBodyBytes ?? 1_048_576 },
          id: 'bodyLimit',
        });
        traefikRedirectSchemeMiddleware({
          name: `${spec.name}-redirect`,
          namespace: spec.namespace,
          id: 'redirect',
        });

        return { ready: true };
      }
    );

    const yaml = edge.toYaml();

    for (const kind of ['HelmRepository', 'HelmRelease', 'GatewayClass', 'Middleware']) {
      expect(yaml).toContain(`kind: ${kind}`);
    }
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
  });
});
