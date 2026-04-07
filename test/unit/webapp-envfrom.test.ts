/**
 * Test that webAppWithProcessing passes envFrom through to the app Deployment.
 */

import { describe, expect, it } from 'bun:test';
import { webAppWithProcessing } from '../../src/factories/webapp/compositions/web-app-with-processing.js';

describe('webAppWithProcessing envFrom', () => {
  it('passes envFrom to the app deployment container', () => {
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

    // Find the app deployment (not the supervisor, not the pooler)
    const appDeploy = graph.resources.find((r) => {
      const name = String(r.manifest?.metadata?.name ?? '');
      return name === 'test-app' && r.manifest?.kind === 'Deployment';
    });
    expect(appDeploy).toBeDefined();

    const container = (appDeploy!.manifest as any)?.spec?.template?.spec?.containers?.[0];
    expect(container).toBeDefined();
    expect(container.envFrom).toEqual([{ secretRef: { name: 'my-secrets' } }]);
  });

  it('omits envFrom when not provided', () => {
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
    expect(container.envFrom).toBeUndefined();
  });
});
