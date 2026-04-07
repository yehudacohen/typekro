/**
 * Test that webAppWithProcessing passes envFrom through to the app Deployment.
 */

import { describe, expect, it } from 'bun:test';
import { webAppWithProcessing } from '../../src/factories/webapp/compositions/web-app-with-processing.js';

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
});
