import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { caddyIngress, DEFAULT_CADDY_VERSION } from '../../../src/factories/caddy/index.js';
import {
  CaddyIngressConfigSchema,
  CaddyIngressStatusSchema,
} from '../../../src/factories/caddy/types.js';

const SAMPLE_CADDYFILE =
  'dagster-dev.acme.internal {\n\ttls internal\n\treverse_proxy dagster.svc:80\n}\n';

describe('Caddy ingress composition', () => {
  it('accepts a valid config through the schema', () => {
    const result = CaddyIngressConfigSchema({
      name: 'caddy',
      namespace: 'caddy-system',
      caddyfile: SAMPLE_CADDYFILE,
      serviceType: 'ClusterIP',
      persistence: { size: '2Gi' },
    });
    expect(result instanceof type.errors).toBe(false);
  });

  it('rejects a config missing the required caddyfile', () => {
    const result = CaddyIngressConfigSchema({ name: 'caddy' });
    expect(result instanceof type.errors).toBe(true);
  });

  it('accepts a valid status through the schema', () => {
    const result = CaddyIngressStatusSchema({ ready: true, version: '2.11.2' });
    expect(result instanceof type.errors).toBe(false);
  });

  it('generates an RGD with the Caddy resources and Caddyfile/status wiring', () => {
    const yaml = caddyIngress.toYaml();
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: caddy-ingress');
    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: ConfigMap');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    // The Caddyfile is a string passthrough from the schema, wired into the ConfigMap.
    expect(yaml).toContain('schema.spec.caddyfile');
    // No Helm anywhere — this is a raw-resource composition.
    expect(yaml).not.toContain('kind: HelmRelease');
  });

  it('readiness respects replicaCount (compares to the Deployment desired replicas, not a baked literal)', () => {
    const yaml = caddyIngress.toYaml();
    // spec.replicas is the Deployment's desired count — NOT the literal `1` from `replicaCount ?? 1`.
    // (Resolves in both kro CEL and, since the LIVE_SPEC_KEY core change, direct-mode hydration.)
    expect(yaml).toContain('caddyDeployment.status.readyReplicas >= caddyDeployment.spec.replicas');
  });

  it('applies the image default in KRO without dereferencing an optional version tag', () => {
    const yaml = caddyIngress.toYaml();
    // image default applied as a single field...
    expect(yaml).toContain('caddy:2.11.2');
    // ...and the image is NOT built by interpolating the optional schema version (which would yield `caddy:`).
    expect(yaml).not.toMatch(/image:.*string\(schema\.spec\.version\)/);
  });

  it('creates both kro and direct factories', () => {
    const kro = caddyIngress.factory('kro', { namespace: 'caddy-system' });
    const direct = caddyIngress.factory('direct', { namespace: 'caddy-system' });
    expect(typeof kro.deploy).toBe('function');
    expect(typeof direct.deploy).toBe('function');
  });

  it('defaults the image tag to the verified current Caddy version', () => {
    expect(DEFAULT_CADDY_VERSION).toBe('2.11.2');
  });
});
