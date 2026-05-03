/**
 * Simple Deployment Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Deployment resources with sensible defaults.
 */

import type { V1Container, V1EnvVar, V1Volume } from '@kubernetes/client-node';
import type { AspectOverrideSchemaNode } from '../../../core/aspects/metadata.js';
import { setAspectMetadata } from '../../../core/aspects/metadata.js';
import type {
  AspectFactoryTargetBrand,
  ResourceSpecOverrideSchema,
} from '../../../core/aspects/types.js';
import { processFactoryValue, withExpressionAnalysis } from '../../../core/expressions/index.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { Enhanced } from '../../../core/types.js';
import type { V1DeploymentSpec, V1DeploymentStatus } from '../../kubernetes/types.js';
import { deployment } from '../../kubernetes/workloads/deployment.js';
import type { DeploymentConfig } from '../types.js';

const _logger = getComponentLogger('simple-deployment-factory');

const DEPLOYMENT_ASPECT_OVERRIDE_SCHEMA: AspectOverrideSchemaNode = Object.freeze({
  kind: 'object',
  children: Object.freeze({
    spec: Object.freeze({
      kind: 'object',
      children: Object.freeze({
        replicas: Object.freeze({ kind: 'scalar' }),
        template: Object.freeze({
          kind: 'object',
          children: Object.freeze({
            metadata: Object.freeze({
              kind: 'object',
              children: Object.freeze({
                labels: Object.freeze({ kind: 'object' }),
              }),
            }),
            spec: Object.freeze({
              kind: 'object',
              children: Object.freeze({
                containers: Object.freeze({ kind: 'array' }),
                volumes: Object.freeze({ kind: 'array' }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

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
        ),
      }))
    : [];

  const resource = deployment({
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
        ),
      }),
      labels: {
        app: processFactoryValue(
          config.name,
          { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
          'metadata.labels.app'
        ),
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
          ),
        },
      },
      template: {
        metadata: {
          labels: {
            app: processFactoryValue(
              config.name,
              { factoryType: 'kro', factoryName: 'Deployment', analysisEnabled: true },
              'spec.template.metadata.labels.app'
            ),
          },
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
              ...(config.command && { command: config.command }),
              ...(config.args && { args: config.args }),
              ...(env.length > 0 && { env }),
              ...(config.envFrom && { envFrom: config.envFrom }),
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
  setAspectMetadata(resource, {
    factoryTarget: 'Deployment',
    targetGroups: ['workloads'],
    surfaces: ['metadata', 'override'],
    name: config.name,
    kind: 'Deployment',
    labels: { app: config.name },
    overrideSchema: DEPLOYMENT_ASPECT_OVERRIDE_SCHEMA,
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
  });
  return resource;
}

/**
 * Creates a simple Deployment with sensible defaults and expression analysis
 *
 * @param config - Configuration for the deployment
 * @param options - Analysis options
 * @returns Enhanced Deployment resource
 *
 * @example
 * ```typescript
 * const web = Deployment({
 *   name: 'web-server',
 *   image: 'nginx:latest',
 *   replicas: 3,
 *   ports: [{ containerPort: 80 }],
 * });
 * ```
 */
type DeploymentAspectSpec = {
  replicas: number;
  template: {
    metadata: { labels: Record<string, string> };
    spec: {
      containers: readonly V1Container[];
      volumes: readonly V1Volume[];
    };
  };
};

const analyzedDeployment = withExpressionAnalysis(createDeployment, 'Deployment');
export const Deployment = analyzedDeployment as typeof analyzedDeployment &
  AspectFactoryTargetBrand<
    'metadata' | 'override',
    ResourceSpecOverrideSchema<DeploymentAspectSpec>
  >;
Reflect.set(Deployment, '__typekroAspectTargetId', 'Deployment');
Reflect.set(Deployment, '__typekroAspectSurfaces', Object.freeze(['metadata', 'override']));
Reflect.set(Deployment, '__typekroAspectOverrideSchema', DEPLOYMENT_ASPECT_OVERRIDE_SCHEMA);
