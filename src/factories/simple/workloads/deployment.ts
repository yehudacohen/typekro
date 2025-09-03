/**
 * Simple Deployment Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Deployment resources with sensible defaults.
 */

import type { V1EnvVar } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types.js';
import type { V1DeploymentSpec, V1DeploymentStatus } from '../../kubernetes/types.js';
import { deployment } from '../../kubernetes/workloads/deployment.js';
import type { DeploymentConfig } from '../types.js';
import { 
  withExpressionAnalysis, 
  processFactoryValue,
} from '../../../core/expressions/index.js';
import { getComponentLogger } from '../../../core/logging/index.js';

const _logger = getComponentLogger('simple-deployment-factory');

/**
 * Creates a simple Deployment with sensible defaults (original implementation)
 *
 * @param config - Configuration for the deployment
 * @returns Enhanced Deployment resource
 */
function createDeployment(
  config: DeploymentConfig
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ 
        name, 
        value: processFactoryValue(
          value, 
          { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
          `env.${name}`
        )
      }))
    : [];

  return deployment({
    ...(config.id && { id: config.id }),
    metadata: {
      name: processFactoryValue(
        config.name,
        { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
        'metadata.name'
      ),
      ...(config.namespace && { 
        namespace: processFactoryValue(
          config.namespace,
          { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
          'metadata.namespace'
        )
      }),
      labels: { 
        app: processFactoryValue(
          config.name,
          { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
          'metadata.labels.app'
        )
      },
    },
    spec: {
      replicas: processFactoryValue(
        config.replicas || 1,
        { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
        'spec.replicas'
      ),
      selector: { 
        matchLabels: { 
          app: processFactoryValue(
            config.name,
            { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
            'spec.selector.matchLabels.app'
          )
        }
      },
      template: {
        metadata: { 
          labels: { 
            app: processFactoryValue(
              config.name,
              { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
              'spec.template.metadata.labels.app'
            )
          }
        },
        spec: {
          containers: [
            {
              name: processFactoryValue(
                config.name,
                { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
                'spec.template.spec.containers[0].name'
              ),
              image: processFactoryValue(
                config.image,
                { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
                'spec.template.spec.containers[0].image'
              ),
              ...(env.length > 0 && { env }),
              ...(config.ports && { ports: config.ports }),
              ...(config.resources && { resources: config.resources }),
              ...(config.volumeMounts && { volumeMounts: config.volumeMounts }),
            },
          ],
          ...(config.volumes && { volumes: config.volumes }),
        },
      },
    },
  });
}

/**
 * Creates a simple Deployment with sensible defaults and expression analysis
 *
 * @param config - Configuration for the deployment
 * @param options - Analysis options
 * @returns Enhanced Deployment resource
 */
export const Deployment = withExpressionAnalysis(createDeployment, 'Deployment');
