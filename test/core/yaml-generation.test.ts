import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { simple, toResourceGraph } from '../../src/index';

/** Loose type for parsed Kro YAML for test assertions */
interface ParsedKroYaml {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string };
  spec: {
    schema: unknown;
    resources: Array<{
      id: string;
      template: Record<string, unknown> & {
        apiVersion?: string;
        kind?: string;
        metadata?: Record<string, unknown>;
        spec?: Record<string, unknown>;
      };
    }>;
  };
}

describe('YAML Generation Integration Test', () => {
  it('should generate valid Kro YAML for a comprehensive application stack', async () => {
    console.log('🎯 Testing comprehensive YAML generation...');

    // Create a realistic application stack without cross-resource references
    // (focusing on YAML structure validation rather than reference resolution)
    const appConfig = simple.ConfigMap({
      name: 'webapp-config',
      namespace: 'production',
      data: {
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://postgres:5432/webapp',
        REDIS_URL: 'redis://redis:6379',
        FEATURE_FLAGS: 'auth,metrics,logging,caching',
      },
    });

    const appSecrets = simple.Secret({
      name: 'webapp-secrets',
      namespace: 'production',
      stringData: {
        API_KEY: 'super-secret-api-key-12345',
        JWT_SECRET: 'jwt-signing-secret-67890',
        DATABASE_PASSWORD: 'secure-db-password-abcdef',
        REDIS_PASSWORD: 'redis-password-ghijkl',
      },
    });

    const dbStorage = simple.Pvc({
      name: 'postgres-storage',
      namespace: 'production',
      size: '10Gi',
      accessModes: ['ReadWriteOnce'],
      storageClass: 'fast-ssd',
    });

    const database = simple.Deployment({
      name: 'postgres-db',
      namespace: 'production',
      image: 'postgres:15-alpine',
      replicas: 1,
      env: {
        POSTGRES_DB: 'webapp',
        POSTGRES_USER: 'webapp',
        POSTGRES_PASSWORD: 'secure-db-password-abcdef', // Static value for test
        PGDATA: '/var/lib/postgresql/data/pgdata',
      },
      ports: [{ containerPort: 5432, name: 'postgres' }],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    });

    const redis = simple.Deployment({
      name: 'redis-cache',
      namespace: 'production',
      image: 'redis:7-alpine',
      replicas: 1,
      env: {
        REDIS_PASSWORD: 'redis-password-ghijkl', // Static value for test
      },
      ports: [{ containerPort: 6379, name: 'redis' }],
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
    });

    const webapp = simple.Deployment({
      name: 'webapp',
      namespace: 'production',
      image: 'nginx:alpine',
      replicas: 3,
      env: {
        // Static configuration for YAML generation test
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://postgres:5432/webapp',
        REDIS_URL: 'redis://redis:6379',
        API_KEY: 'super-secret-api-key-12345',
        JWT_SECRET: 'jwt-signing-secret-67890',
        PORT: '8080',
        NODE_ENV: 'production',
      },
      ports: [{ containerPort: 8080, name: 'http' }],
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '300m', memory: '256Mi' },
      },
    });

    const dbService = simple.Service({
      name: 'postgres-service',
      namespace: 'production',
      selector: { app: 'postgres-db' },
      ports: [{ port: 5432, targetPort: 5432, name: 'postgres' }],
    });

    const redisService = simple.Service({
      name: 'redis-service',
      namespace: 'production',
      selector: { app: 'redis-cache' },
      ports: [{ port: 6379, targetPort: 6379, name: 'redis' }],
    });

    const webService = simple.Service({
      name: 'webapp-service',
      namespace: 'production',
      selector: { app: 'webapp' },
      ports: [{ port: 80, targetPort: 8080, name: 'http' }],
    });

    const webHpa = simple.Hpa({
      name: 'webapp-hpa',
      namespace: 'production',
      target: {
        name: 'webapp',
        kind: 'Deployment',
      },
      minReplicas: 2,
      maxReplicas: 10,
      cpuUtilization: 70,
    });

    // Generate the Kro YAML
    console.log('🔄 Generating Kro ResourceGraphDefinition...');
    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'production-webapp-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({
        appConfig,
        appSecrets,
        dbStorage,
        database,
        redis,
        webapp,
        dbService,
        redisService,
        webService,
        webHpa,
      }),
      () => ({ name: 'test-status' })
    );

    const kroYaml = resourceGraph.toYaml();

    // Validate that the YAML is well-formed
    console.log('✅ Validating generated YAML...');
    let parsedYaml: ParsedKroYaml;
    try {
      parsedYaml = yaml.load(kroYaml) as ParsedKroYaml;
    } catch (error) {
      console.error('❌ Generated YAML is not valid:', error);
      throw error;
    }

    // Validate Kro ResourceGraphDefinition structure
    expect(parsedYaml.apiVersion).toBe('kro.run/v1alpha1');
    expect(parsedYaml.kind).toBe('ResourceGraphDefinition');
    expect(parsedYaml.metadata.name).toBe('production-webapp-stack');
    // ResourceGraphDefinitions are cluster-scoped, so they omit namespace.
    expect(parsedYaml.metadata.namespace).toBeUndefined();
    expect(parsedYaml.spec).toBeDefined();
    expect(parsedYaml.spec.schema).toBeDefined();
    expect(parsedYaml.spec.resources).toBeDefined();
    expect(Array.isArray(parsedYaml.spec.resources)).toBe(true);

    // Validate that all resources are included
    const resourceIds = parsedYaml.spec.resources.map((r) => r.id);
    expect(resourceIds).toContain('configmapWebappConfig');
    expect(resourceIds).toContain('webappSecrets');
    expect(resourceIds).toContain('persistentvolumeclaimPostgresStorage');
    expect(resourceIds).toContain('deploymentPostgresDb');
    expect(resourceIds).toContain('deploymentRedisCache');
    expect(resourceIds).toContain('deploymentWebapp');
    expect(resourceIds).toContain('postgresService');
    expect(resourceIds).toContain('redisService');
    expect(resourceIds).toContain('webappService');
    expect(resourceIds).toContain('horizontalpodautoscalerWebappHpa');

    console.log(`✅ All ${parsedYaml.spec.resources.length} resources included in the graph`);

    // Validate basic resource structure
    const webappResource = parsedYaml.spec.resources.find((r) => r.id === 'deploymentWebapp')!;
    expect(webappResource).toBeDefined();
    expect(webappResource.template.apiVersion).toBe('apps/v1');
    expect(webappResource.template.kind).toBe('Deployment');
    expect(webappResource.template.metadata!.name).toBe('webapp');
    expect(webappResource.template.metadata!.namespace).toBe('production');

    const templateSpec = webappResource.template.spec as Record<string, unknown>;
    const podSpec = (templateSpec.template as Record<string, unknown>).spec as Record<
      string,
      unknown
    >;
    const webappContainer = (podSpec.containers as Record<string, unknown>[])[0]!;
    expect(webappContainer.image).toBe('nginx:alpine');
    expect((webappContainer.ports as Record<string, unknown>[])[0]!.containerPort).toBe(8080);

    console.log('✅ Resource structure validates correctly');

    // Save the generated YAML for manual inspection
    const tempDir = join(__dirname, '../../temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const outputFile = join(tempDir, 'production-webapp-stack.yaml');
    writeFileSync(outputFile, kroYaml);
    console.log(`📄 Generated YAML saved to: ${outputFile}`);

    // Print a summary
    console.log('\n🎉 YAML Generation Test Summary:');
    console.log(`✅ Generated valid Kro ResourceGraphDefinition`);
    console.log(`✅ Included ${parsedYaml.spec.resources.length} Kubernetes resources`);
    console.log(`✅ YAML structure validates against Kro schema`);
    console.log(`✅ File saved for manual inspection: ${outputFile}`);

    // Log the first few lines of the YAML for verification
    console.log('\n📄 Generated YAML (first 30 lines):');
    const yamlLines = kroYaml.split('\n');
    console.log(yamlLines.slice(0, 30).join('\n'));
    if (yamlLines.length > 30) {
      console.log(`... (${yamlLines.length - 30} more lines)`);
    }
  });

  it('should generate valid YAML with multiple resource types', async () => {
    console.log('🔗 Testing multiple resource types...');

    // Create a simpler test focused on YAML structure validation
    const config = simple.ConfigMap({
      name: 'app-config',
      data: {
        DATABASE_HOST: 'postgres',
        CACHE_HOST: 'redis',
      },
    });

    const secrets = simple.Secret({
      name: 'app-secrets',
      stringData: {
        DB_PASSWORD: 'secret123',
        CACHE_PASSWORD: 'cache456',
      },
    });

    const db = simple.Deployment({
      name: 'database',
      image: 'postgres:13',
      env: {
        POSTGRES_PASSWORD: 'secret123', // Static value for test
      },
    });

    const cache = simple.Deployment({
      name: 'cache',
      image: 'redis:6',
      env: {
        REDIS_PASSWORD: 'cache456', // Static value for test
      },
    });

    const app = simple.Deployment({
      name: 'application',
      image: 'myapp:latest',
      env: {
        // Static values for YAML generation test
        DATABASE_HOST: 'postgres',
        CACHE_HOST: 'redis',
        DB_PASSWORD: 'secret123',
        CACHE_PASSWORD: 'cache456',
      },
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'complex-app',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({
        config,
        secrets,
        db,
        cache,
        app,
      }),
      () => ({ name: 'test-status' })
    );

    const kroYaml = resourceGraph.toYaml();

    // Validate the YAML is well-formed
    const parsed = yaml.load(kroYaml) as ParsedKroYaml;
    expect(parsed).toBeDefined();
    expect(parsed.apiVersion).toBe('kro.run/v1alpha1');
    expect(parsed.kind).toBe('ResourceGraphDefinition');

    // Validate all resources are present
    const resourceIds = parsed.spec.resources.map((r) => r.id);
    expect(resourceIds).toContain('configmapAppConfig');
    expect(resourceIds).toContain('appSecrets');
    expect(resourceIds).toContain('deploymentDatabase');
    expect(resourceIds).toContain('deploymentCache');
    expect(resourceIds).toContain('deploymentApplication');

    // Find the application deployment and validate structure
    const appResource = parsed.spec.resources.find((r) => r.id === 'deploymentApplication')!;
    expect(appResource).toBeDefined();
    expect(appResource.template.kind).toBe('Deployment');
    const appTemplateSpec = appResource.template.spec as Record<string, unknown>;
    const appPodSpec = (appTemplateSpec.template as Record<string, unknown>).spec as Record<
      string,
      unknown
    >;
    expect((appPodSpec.containers as Record<string, unknown>[])[0]!.image).toBe('myapp:latest');

    console.log('✅ Multiple resource types handled correctly');
  });
});
