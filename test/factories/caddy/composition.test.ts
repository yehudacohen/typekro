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
    const result = CaddyIngressStatusSchema({ ready: true, phase: 'Ready', version: '2.11.2' });
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
    // Readiness derives from the Deployment's readyReplicas (direct proxy comparison → CEL).
    expect(yaml).toContain('readyReplicas');
    // No Helm anywhere — this is a raw-resource composition.
    expect(yaml).not.toContain('kind: HelmRelease');
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
