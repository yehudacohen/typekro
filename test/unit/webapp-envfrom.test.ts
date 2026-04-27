/**
 * Test that webAppWithProcessing passes envFrom through to the app Deployment.
 */

import { describe, expect, it } from 'bun:test';
import { webAppWithProcessing } from '../../src/factories/webapp/compositions/web-app-with-processing.js';
import { WebAppWithProcessingConfigSchema } from '../../src/factories/webapp/types.js';

describe('webAppWithProcessing envFrom', () => {
  it('always mounts inngest credentials Secret via envFrom', () => {
    const factory = webAppWithProcessing.factory('direct', { namespace: 'test' });
    const graph = factory.createResourceGraphForInstance({
      name: 'test-app',
      app: { image: 'nginx:alpine' },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    const appDeploy = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app' && r.manifest?.kind === 'Deployment';
    });
    expect(appDeploy).toBeDefined();

    const container = (appDeploy!.manifest as any)?.spec?.template?.spec?.containers?.[0];
    expect(container).toBeDefined();
    // Inngest credentials Secret is always mounted
    expect(container.envFrom).toContainEqual({
      secretRef: { name: 'test-app-inngest-credentials' },
    });
  });

  it('merges user-provided envFrom with inngest credentials Secret', () => {
    const factory = webAppWithProcessing.factory('direct', { namespace: 'test' });
    const graph = factory.createResourceGraphForInstance({
      name: 'test-app',
      app: {
        image: 'nginx:alpine',
        envFrom: [{ secretRef: { name: 'my-secrets' } }],
      },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    const appDeploy = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app' && r.manifest?.kind === 'Deployment';
    });
    expect(appDeploy).toBeDefined();

    const container = (appDeploy!.manifest as any)?.spec?.template?.spec?.containers?.[0];
    expect(container).toBeDefined();
    // Both inngest credentials and user secrets should be present
    expect(container.envFrom).toContainEqual({
      secretRef: { name: 'test-app-inngest-credentials' },
    });
    expect(container.envFrom).toContainEqual({
      secretRef: { name: 'my-secrets' },
    });
  });

  it('passes Inngest resource overrides through to the HelmRelease', () => {
    const factory = webAppWithProcessing.factory('direct', { namespace: 'test' });
    const graph = factory.createResourceGraphForInstance({
      name: 'test-app',
      app: { image: 'nginx:alpine' },
      database: { storageSize: '1Gi' },
      processing: {
        eventKey: 'test',
        signingKey: 'test',
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { cpu: '250m', memory: '256Mi' },
        },
      },
    });

    const inngestRelease = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app-inngest' && r.manifest?.kind === 'HelmRelease';
    });
    expect(inngestRelease).toBeDefined();

    const values = (inngestRelease!.manifest as any)?.spec?.values;
    expect(values?.resources).toEqual({
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '250m', memory: '256Mi' },
    });
  });

  it('scopes the Inngest HelmRepository name by app namespace', () => {
    const factory = webAppWithProcessing.factory('direct', { namespace: 'test' });
    const graph = factory.createResourceGraphForInstance({
      name: 'test-app',
      namespace: 'app-ns',
      app: { image: 'nginx:alpine' },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    const repository = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app-app-ns-inngest-repo' && r.manifest?.kind === 'HelmRepository';
    });
    expect(repository).toBeDefined();

    const release = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app-inngest' && r.manifest?.kind === 'HelmRelease';
    });
    expect(release).toBeDefined();
    expect((release!.manifest as any)?.spec?.chart?.spec?.sourceRef?.name).toBe(
      'test-app-app-ns-inngest-repo'
    );
  });

  it('accepts envFrom entries with exactly one source ref', () => {
    const secretResult = WebAppWithProcessingConfigSchema({
      name: 'test-app',
      app: { image: 'nginx:alpine', envFrom: [{ secretRef: { name: 'my-secrets' } }] },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });
    const configMapResult = WebAppWithProcessingConfigSchema({
      name: 'test-app',
      app: { image: 'nginx:alpine', envFrom: [{ configMapRef: { name: 'my-config' } }] },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    expect('summary' in (secretResult as object)).toBe(false);
    expect('summary' in (configMapResult as object)).toBe(false);
  });

  it('accepts Kubernetes envFrom prefix and optional fields', () => {
    const result = WebAppWithProcessingConfigSchema({
      name: 'test-app',
      app: {
        image: 'nginx:alpine',
        envFrom: [
          { prefix: 'SECRET_', secretRef: { name: 'my-secrets', optional: true } },
          { prefix: 'CONFIG_', configMapRef: { name: 'my-config', optional: false } },
        ],
      },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    expect('summary' in (result as object)).toBe(false);
  });

  it('rejects envFrom entries with both or neither source refs', () => {
    const bothResult = WebAppWithProcessingConfigSchema({
      name: 'test-app',
      app: {
        image: 'nginx:alpine',
        envFrom: [{ secretRef: { name: 'my-secrets' }, configMapRef: { name: 'my-config' } }],
      },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });
    const neitherResult = WebAppWithProcessingConfigSchema({
      name: 'test-app',
      app: { image: 'nginx:alpine', envFrom: [{}] },
      database: { storageSize: '1Gi' },
      processing: { eventKey: 'test', signingKey: 'test' },
    });

    expect('summary' in (bothResult as object)).toBe(true);
    expect('summary' in (neitherResult as object)).toBe(true);
  });

  it('emits an object-array KRO schema for envFrom entries', () => {
    const yaml = webAppWithProcessing.toYaml();

    expect(yaml).toContain('envFrom: "[]object"');
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('enum="object,object"');
  });
});
