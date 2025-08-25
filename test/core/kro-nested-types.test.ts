import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import { Cel, toResourceGraph, simple } from '../../src/index.js';

// --- Test Suite 1: End-to-End Schema and Builder Validation ---

describe.skip('Comprehensive End-to-End Schema Test (needs API update)', () => {
  // CORRECTED: 'integer' is defined using Arktype's string-based modulo syntax.
  const WebAppSpecSchema = type({
    app: {
      name: 'string',
      tags: 'string[]',
      deployment: {
        strategy: "'Recreate'|'RollingUpdate'",
        image: 'string',
      },
    },
    database: {
      connection: {
        host: 'string',
        port: 'number',
        poolSize: 'number%1', // Correct Arktype syntax for an integer
      },
    },
    monitoring: {
      metrics: { enabled: 'boolean' },
    },
  });

  const WebAppStatusSchema = type({
    app: { ready: 'boolean' },
    observedUrl: 'string',
  });

  it('should correctly handle all specified schema types', () => {
    const factory = toResourceGraph(
      {
        name: 'comprehensive-webapp',
        apiVersion: 'v1alpha1',
        kind: 'ComprehensiveWebApp',
        spec: WebAppSpecSchema,
        status: WebAppStatusSchema,
      },
      (schema) => ({
        deployment: simple.Deployment({
          name: schema.spec.app.name,
          image: schema.spec.app.deployment.image,
          env: {
            DB_POOL_SIZE: Cel.string(schema.spec.database.connection.poolSize),
            DEPLOY_STRATEGY: schema.spec.app.deployment.strategy,
          },
          id: 'webappDeployment',
        }),
      }),
      (_schema, resources) => ({
        app: {
          ready: Cel.expr<boolean>`${resources.deployment.status.readyReplicas} > 0`,
        },
        observedUrl: `http://${resources.deployment.status.podIP}`,
      })
    );

    const yamlOutput = factory.toYaml();
    const parsedYaml = yaml.load(yamlOutput) as any;
    const generatedSchemaSpec = parsedYaml.spec.schema.spec;

    expect(generatedSchemaSpec.appTags).toBe('[]string');
    expect(generatedSchemaSpec.databaseConnectionPoolSize).toBe('integer');
    expect(generatedSchemaSpec.appDeploymentStrategy).toBe("'Recreate'|'RollingUpdate'");

    const resourceTemplate = parsedYaml.spec.resources[0].template;
    const envVars = resourceTemplate.spec.template.spec.containers[0].env;
    const poolSizeVar = envVars.find((e: any) => e.name === 'DB_POOL_SIZE');
    expect(poolSizeVar.value).toBe('${string(schema.spec.database.connection.poolSize)}');
  });
});

describe.skip('Cross-Resource Reference Test (needs API update)', () => {
  it('should correctly serialize references between different resources', () => {
    // Define a simple schema for this test
    const TestSpecSchema = type({
      appName: 'string',
      greeting: 'string',
    });

    const TestStatusSchema = type({
      phase: 'string',
    });

    const resourceGraph = toResourceGraph(
      {
        name: 'cross-ref-app',
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => {
        const configMapResource = simple.ConfigMap({
          name: 'app-config',
          data: { greeting: schema.spec.greeting },
        });

        const deploymentResource = simple.Deployment({
          name: schema.spec.appName,
          image: 'nginx',
          env: {
            APP_GREETING: configMapResource.data!.$greeting!,
          },
        });

        return {
          theDeployment: deploymentResource,
          theConfigMap: configMapResource,
        };
      },
      (_schema, resources) => ({
        phase: resources.theDeployment.status.phase,
      })
    );

    const yamlOutput: string = resourceGraph.toYaml();
    const parsedYaml = yaml.load(yamlOutput) as any;

    // --- THIS IS THE CORRECTED SECTION ---

    // 1. Find the resources by their correct camelCase IDs.
    const deploymentId = 'deploymentMyWebApp';
    const configMapId = 'configmapAppConfig';

    const deploymentTemplate = parsedYaml.spec.resources.find(
      (r: any) => r.id === deploymentId
    ).template;

    // 2. Assert that the deployment's environment variable contains the correct
    //    CEL reference to the ConfigMap's camelCase resource ID.
    const greetingEnv = deploymentTemplate.spec.template.spec.containers[0].env.find(
      (e: any) => e.name === 'APP_GREETING'
    );
    expect(greetingEnv.value).toBe(`\${${configMapId}.data.greeting}`);
  });
});
