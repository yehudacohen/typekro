import { describe, expect, mock, test } from 'bun:test';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import {
  deployKroResourceForTest,
} from '../../../src/alchemy/resource-registration.js';
import type { TypeKroDeployer } from '../../../src/alchemy/types.js';
import { createMockKubeConfig } from '../../utils/mock-factories.js';

describe('Alchemy KRO artifact-binding migration', () => {
  test('runs migration before deployment through the complete reconcile path', async () => {
    const events: string[] = [];
    const resource = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'application' },
      spec: {
        schema: {
          apiVersion: 'v1alpha1',
          group: 'application.example',
          kind: 'Application',
          spec: {
            typekroArtifactBindings: 'map[string]map[string]string',
          },
        },
      },
    } as unknown as Enhanced<Record<string, unknown>, Record<string, unknown>>;
    const deployer: TypeKroDeployer = {
      deploy: mock(async (deployed) => {
        events.push('deploy');
        return deployed;
      }),
      delete: mock(async () => undefined),
      dispose: mock(async () => undefined),
    };
    const migrate = mock(async () => {
      events.push('migrate');
    });

    await deployKroResourceForTest(
      {
        resource,
        namespace: 'typekro-system',
        deploymentStrategy: 'kro',
        deployer,
      },
      undefined,
      {
        migrateLegacyArtifactBindings: migrate,
        kubeConfigForMigration: createMockKubeConfig,
      }
    );

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['migrate', 'deploy']);
  });
});
