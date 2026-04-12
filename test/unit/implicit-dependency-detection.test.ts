/**
 * Tests for DependencyResolver implicit dependency detection via
 * dnsAddressable resources and string value matching.
 *
 * The resolver scans env vars, command/args, and (for non-container resources)
 * shallow spec fields for strings that contain a dnsAddressable resource's
 * metadata.name at a word boundary defined by the regex:
 *   (?:^|[/:@.])name(?:[/:@.]|$)
 *
 * Only resources marked with { dnsAddressable: true } in their metadata
 * (e.g., Service, CNPG Cluster, Valkey) are candidates. Deployment is
 * NOT dnsAddressable.
 */

import { describe, expect, it } from 'bun:test';
import { DependencyResolver } from '../../src/core/dependencies/resolver.js';
import { setMetadataField } from '../../src/core/metadata/resource-metadata.js';
import type { DeployableK8sResource, Enhanced } from '../../src/core/types/kubernetes.js';

type TestResource = DeployableK8sResource<Enhanced<object, object>>;

/**
 * Build a minimal mock resource. For Service-like resources, the caller
 * must also call `markDnsAddressable()`.
 */
function mockResource(opts: {
  id: string;
  kind: string;
  name: string;
  spec?: Record<string, unknown>;
}): TestResource {
  return {
    id: opts.id,
    kind: opts.kind,
    apiVersion: opts.kind === 'Service' ? 'v1' : 'apps/v1',
    metadata: { name: opts.name },
    spec: opts.spec ?? {},
    status: {},
  } as unknown as TestResource;
}

/** Mark a resource as dnsAddressable (mirrors what `service()` factory does). */
function markDnsAddressable(resource: TestResource): void {
  setMetadataField(resource, 'dnsAddressable', true);
}

/**
 * Build a Deployment-shaped resource whose container env includes the
 * given environment variables.
 */
function mockDeploymentWithEnv(opts: {
  id: string;
  name: string;
  env: Record<string, string>;
}): TestResource {
  const envArray = Object.entries(opts.env).map(([k, v]) => ({
    name: k,
    value: v,
  }));

  return {
    id: opts.id,
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: { name: opts.name },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: opts.name,
              image: 'test:latest',
              env: envArray,
            },
          ],
        },
      },
    },
    status: {},
  } as unknown as TestResource;
}

/**
 * Build a Deployment-shaped resource whose container args include the
 * given strings.
 */
function mockDeploymentWithArgs(opts: {
  id: string;
  name: string;
  args: string[];
}): TestResource {
  return {
    id: opts.id,
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: { name: opts.name },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: opts.name,
              image: 'test:latest',
              args: opts.args,
            },
          ],
        },
      },
    },
    status: {},
  } as unknown as TestResource;
}

describe('Implicit dependency detection', () => {
  const resolver = new DependencyResolver();

  // -----------------------------------------------------------------------
  // Positive cases
  // -----------------------------------------------------------------------

  describe('positive cases — env var containing a service hostname creates a dependency edge', () => {
    it('DATABASE_URL containing service name creates dependency', () => {
      const svc = mockResource({
        id: 'serviceMyDb',
        kind: 'Service',
        name: 'my-db',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { DATABASE_URL: 'postgresql://my-db:5432/appdb' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).toContain('serviceMyDb');
    });

    it('REDIS_HOST containing service name at start of string creates dependency', () => {
      const svc = mockResource({
        id: 'serviceCache',
        kind: 'Service',
        name: 'my-cache',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { REDIS_HOST: 'my-cache:6379' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).toContain('serviceCache');
    });

    it('hostname with user@host pattern creates dependency', () => {
      const svc = mockResource({
        id: 'serviceDb',
        kind: 'Service',
        name: 'postgres-pooler',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { DATABASE_URL: 'postgresql://appuser@postgres-pooler:5432/mydb' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).toContain('serviceDb');
    });

    it('service name in container args creates dependency', () => {
      const svc = mockResource({
        id: 'serviceBackend',
        kind: 'Service',
        name: 'backend-api',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithArgs({
        id: 'deploymentWorker',
        name: 'worker',
        args: ['--upstream', 'http://backend-api:8080/api'],
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentWorker');

      expect(deps).toContain('serviceBackend');
    });

    it('multiple services can each create separate dependency edges', () => {
      const dbSvc = mockResource({
        id: 'serviceDb',
        kind: 'Service',
        name: 'app-db',
      });
      markDnsAddressable(dbSvc);

      const cacheSvc = mockResource({
        id: 'serviceCache',
        kind: 'Service',
        name: 'app-cache',
      });
      markDnsAddressable(cacheSvc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: {
          DATABASE_URL: 'postgresql://app-db:5432/mydb',
          REDIS_URL: 'redis://app-cache:6379',
        },
      });

      const graph = resolver.buildDependencyGraph([dbSvc, cacheSvc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).toContain('serviceDb');
      expect(deps).toContain('serviceCache');
    });

    it('service name delimited by dots creates dependency (FQDN pattern)', () => {
      const svc = mockResource({
        id: 'serviceDb',
        kind: 'Service',
        name: 'my-db',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { DB_HOST: 'my-db.default.svc.cluster.local' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).toContain('serviceDb');
    });
  });

  // -----------------------------------------------------------------------
  // Negative cases
  // -----------------------------------------------------------------------

  describe('negative cases', () => {
    it('Deployment metadata.name in a label does NOT create a dependency (Deployment is not dnsAddressable)', () => {
      // Deployment is NOT dnsAddressable — its name appearing in another
      // resource's env should NOT create an implicit dependency.
      const deploy1 = mockResource({
        id: 'deploymentFrontend',
        kind: 'Deployment',
        name: 'frontend',
      });
      // Intentionally NOT calling markDnsAddressable(deploy1)

      const deploy2 = mockDeploymentWithEnv({
        id: 'deploymentBackend',
        name: 'backend',
        env: { FRONTEND_HOST: 'frontend:3000' },
      });

      const graph = resolver.buildDependencyGraph([deploy1, deploy2]);
      const deps = graph.getDependencies('deploymentBackend');

      expect(deps).not.toContain('deploymentFrontend');
    });

    it('partial substring match does not trigger — service name "db" does not match "adb"', () => {
      const svc = mockResource({
        id: 'serviceDb',
        kind: 'Service',
        name: 'db',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { SOME_VAR: 'adb-connection' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).not.toContain('serviceDb');
    });

    it('partial substring match does not trigger — service name "db" does not match "debug"', () => {
      const svc = mockResource({
        id: 'serviceDb',
        kind: 'Service',
        name: 'db',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { LOG_LEVEL: 'debug' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).not.toContain('serviceDb');
    });

    it('CEL expression strings containing service names are not matched (name has $ which is excluded)', () => {
      // The resolver skips resources whose metadata.name contains '$'
      // because CEL-generated names cannot be statically matched.
      const svc = mockResource({
        id: 'serviceDynamic',
        kind: 'Service',
        name: '${schema.name}-svc',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { HOST: '${schema.name}-svc:8080' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      // No dependency because the service name contains '$'
      expect(deps).not.toContain('serviceDynamic');
    });

    it('a resource does not create a dependency on itself', () => {
      const svc = mockResource({
        id: 'serviceSelf',
        kind: 'Service',
        name: 'my-svc',
      });
      markDnsAddressable(svc);
      // Give the service a spec with containers referencing its own name
      (svc as any).spec = {
        template: {
          spec: {
            containers: [
              { name: 'sidecar', image: 'envoy:latest', env: [{ name: 'UPSTREAM', value: 'my-svc:8080' }] },
            ],
          },
        },
      };

      const graph = resolver.buildDependencyGraph([svc]);
      const deps = graph.getDependencies('serviceSelf');

      expect(deps).not.toContain('serviceSelf');
    });

    it('plain text without delimiters does not match (service name "cache" vs "mycache")', () => {
      const svc = mockResource({
        id: 'serviceCache',
        kind: 'Service',
        name: 'cache',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { HOST: 'mycache-server' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).not.toContain('serviceCache');
    });

    it('service name as suffix without delimiter does not match', () => {
      const svc = mockResource({
        id: 'serviceCache',
        kind: 'Service',
        name: 'cache',
      });
      markDnsAddressable(svc);

      const app = mockDeploymentWithEnv({
        id: 'deploymentApp',
        name: 'app',
        env: { HOST: 'memcache' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      const deps = graph.getDependencies('deploymentApp');

      expect(deps).not.toContain('serviceCache');
    });
  });

  // -----------------------------------------------------------------------
  // Word-boundary regex behavior
  // -----------------------------------------------------------------------

  describe('word-boundary regex (?:^|[/:@.])name(?:[/:@.]|$)', () => {
    // The regex matches service names delimited by: start/end of string,
    // or one of the characters: / : @ .

    it('matches name at start of string followed by :', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'redis' });
      markDnsAddressable(svc);
      const app = mockDeploymentWithEnv({
        id: 'app',
        name: 'app',
        env: { HOST: 'redis:6379' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      expect(graph.getDependencies('app')).toContain('svc');
    });

    it('matches name at end of string preceded by @', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'myhost' });
      markDnsAddressable(svc);
      const app = mockDeploymentWithEnv({
        id: 'app',
        name: 'app',
        env: { DSN: 'user@myhost' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      expect(graph.getDependencies('app')).toContain('svc');
    });

    it('matches name delimited by / on both sides', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'api-gw' });
      markDnsAddressable(svc);
      const app = mockDeploymentWithEnv({
        id: 'app',
        name: 'app',
        env: { PROXY: 'http://api-gw/v1' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      expect(graph.getDependencies('app')).toContain('svc');
    });

    it('matches name preceded by . and followed by end of string', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'local' });
      markDnsAddressable(svc);
      const app = mockDeploymentWithEnv({
        id: 'app',
        name: 'app',
        env: { DNS: 'svc.cluster.local' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      expect(graph.getDependencies('app')).toContain('svc');
    });

    it('does NOT match when name is surrounded by alphanumeric characters', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'app' });
      markDnsAddressable(svc);
      const deploy = mockDeploymentWithEnv({
        id: 'deploy',
        name: 'other',
        env: { VAR: 'myapplication' },
      });

      const graph = resolver.buildDependencyGraph([svc, deploy]);
      expect(graph.getDependencies('deploy')).not.toContain('svc');
    });

    it('does NOT match when name is preceded by hyphen (not a valid delimiter)', () => {
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'cache' });
      markDnsAddressable(svc);
      const deploy = mockDeploymentWithEnv({
        id: 'deploy',
        name: 'other',
        env: { VAR: 'my-cache-server' },
      });

      const graph = resolver.buildDependencyGraph([svc, deploy]);
      // Hyphen is NOT in the delimiter set [/:@.], so 'my-cache-server'
      // does not match the regex for 'cache'.
      expect(graph.getDependencies('deploy')).not.toContain('svc');
    });

    it('matches name that is the entire string', () => {
      // The regex (?:^|[/:@.])name(?:[/:@.]|$) — ^ matches start, $ matches end.
      const svc = mockResource({ id: 'svc', kind: 'Service', name: 'standalone' });
      markDnsAddressable(svc);
      const app = mockDeploymentWithEnv({
        id: 'app',
        name: 'app',
        env: { HOST: 'standalone' },
      });

      const graph = resolver.buildDependencyGraph([svc, app]);
      expect(graph.getDependencies('app')).toContain('svc');
    });
  });

  // -----------------------------------------------------------------------
  // Integration: using actual factory functions
  // -----------------------------------------------------------------------

  describe('integration with actual factories', () => {
    it('service() factory sets dnsAddressable, deployment() does not', () => {
      // Use the actual simple factories to prove the metadata is set correctly
      const { simple } = require('../../src/factories/simple/index.js');

      const svc = simple.Service({
        name: 'my-db-svc',
        selector: { app: 'db' },
        ports: [{ port: 5432 }],
      });

      const deploy = simple.Deployment({
        name: 'my-db-svc',
        image: 'postgres:16',
      });

      const { getMetadataField } = require('../../src/core/metadata/resource-metadata.js');

      expect(getMetadataField(svc, 'dnsAddressable')).toBe(true);
      expect(getMetadataField(deploy, 'dnsAddressable')).toBeUndefined();
    });
  });
});
