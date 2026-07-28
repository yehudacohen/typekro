/**
 * Tests for proper status field generation with CEL expressions
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, createResource, externalRef, simple, toResourceGraph } from '../../src/index.js';

describe('Status Field Generation', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
  });

  const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number%1',
    deploymentConditions: 'string[]',
  });

  describe('CEL expression generation', () => {
    it('should generate CEL expressions for status fields based on available resources', () => {
      const graph = toResourceGraph(
        {
          name: 'webapp-with-status',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
          service: simple.Service({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: Cel.template('http://%s', resources.service?.status.loadBalancer?.ingress?.[0]?.ip),
          deploymentConditions: Cel.expr<string[]>(
            resources.deployment?.status.conditions,
            '.map(c, c.type)'
          ),
        })
      );

      const yaml = graph.toYaml();

      // Should contain CEL expressions for status fields, not type definitions
      expect(yaml).toContain('readyReplicas: ${webappDeployment.status.readyReplicas}');
      expect(yaml).toContain('url: http://${webappService.status.loadBalancer.ingress[0].ip}');
      expect(yaml).toContain(
        'deploymentConditions: ${webappDeployment.status.conditions.map(c, c.type)}'
      );

      // Should not contain type definitions for user status fields
      expect(yaml).not.toContain('readyReplicas: integer');
      expect(yaml).not.toContain('deploymentConditions: string[]');
      expect(yaml).not.toContain('url: string');

      // Should not contain default Kro status fields (these are auto-injected by Kro)
      expect(yaml).not.toContain('phase: string');
      expect(yaml).not.toContain('message: string');
      expect(yaml).not.toContain('observedGeneration: integer');
    });

    it('should map common status field names to appropriate resources', () => {
      const graph = toResourceGraph(
        {
          name: 'deployment-status-test',
          apiVersion: 'v1alpha1',
          kind: 'DeploymentApp',
          spec: WebAppSpecSchema,
          status: type({
            availableReplicas: 'number%1',
            deploymentConditions: 'string[]',
            replicas: 'number%1',
          }),
        },
        (schema) => ({
          webDeployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webDeployment',
          }),
        }),
        (_schema, resources) => ({
          availableReplicas: resources.webDeployment?.status.availableReplicas,
          deploymentConditions: Cel.expr<string[]>(
            resources.webDeployment?.status.conditions,
            '.map(c, c.type)'
          ),
          replicas: resources.webDeployment?.status.replicas,
        })
      );

      const yaml = graph.toYaml();

      // Should map to deployment status fields
      expect(yaml).toContain('availableReplicas: ${webDeployment.status.availableReplicas}');
      expect(yaml).toContain(
        'deploymentConditions: ${webDeployment.status.conditions.map(c, c.type)}'
      );
      expect(yaml).toContain('replicas: ${webDeployment.status.replicas}');
    });

    it('should handle service endpoint status fields', () => {
      const graph = toResourceGraph(
        {
          name: 'service-status-test',
          apiVersion: 'v1alpha1',
          kind: 'ServiceApp',
          spec: WebAppSpecSchema,
          status: type({
            endpoint: 'string',
            serviceEndpoint: 'string',
            url: 'string',
          }),
        },
        (schema) => ({
          webService: simple.Service({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'webService',
          }),
        }),
        (_schema, resources) => ({
          endpoint: resources.webService.status.loadBalancer.ingress?.[0]?.ip,
          serviceEndpoint: resources.webService.status.loadBalancer.ingress?.[0]?.hostname,
          url: Cel.template('http://%s', resources.webService?.metadata?.name),
        })
      );

      const yaml = graph.toYaml();

      // Should map to service status fields
      expect(yaml).toContain('endpoint: ${webService.status.loadBalancer.ingress?[0]?.ip}');
      expect(yaml).toContain(
        'serviceEndpoint: ${webService.status.loadBalancer.ingress?[0]?.hostname}'
      );
      // url field is now treated as static since it uses resource metadata
    });

    it('should handle mixed resource types correctly', () => {
      const graph = toResourceGraph(
        {
          name: 'mixed-resources-test',
          apiVersion: 'v1alpha1',
          kind: 'MixedApp',
          spec: WebAppSpecSchema,
          status: type({
            readyReplicas: 'number%1',
            url: 'string',
            customField: 'string',
          }),
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'appDeployment',
          }),
          service: simple.Service({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'appService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: resources.service.status.loadBalancer?.ingress?.[0]?.ip,
          customField: 'custom-value',
        })
      );

      const yaml = graph.toYaml();

      // Should map deployment fields to deployment
      expect(yaml).toContain('readyReplicas: ${appDeployment.status.readyReplicas}');

      // Should map service fields to service
      expect(yaml).toContain('url: ${appService.status.loadBalancer?.ingress?[0]?.ip}');

      // Static fields should NOT be in the YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('customField:');
    });

    it('should provide fallback for resources without matching types', () => {
      const graph = toResourceGraph(
        {
          name: 'fallback-test',
          apiVersion: 'v1alpha1',
          kind: 'ConfigApp',
          spec: type({ name: 'string' }),
          status: type({
            readyReplicas: 'number%1',
            url: 'string',
          }),
        },
        () => ({
          // No deployment or service, just a config map
          configMap: simple.ConfigMap({
            name: 'test-config',
            id: 'testConfig',
            data: { key: 'value' },
          }),
        }),
        (_schema, _resources) => ({
          readyReplicas: 0,
          url: '',
        })
      );

      const yaml = graph.toYaml();

      // Static fallback values should NOT be in the YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('readyReplicas:');
      expect(yaml).not.toContain('url:');
    });

    it('persists explicit status projections from ConfigMap data', () => {
      const graph = toResourceGraph(
        {
          name: 'config-data-status-test',
          apiVersion: 'v1alpha1',
          kind: 'ConfigDataStatus',
          spec: type({ name: 'string' }),
          status: type({
            version: 'string',
            digest: 'string',
          }),
        },
        (schema) => ({
          contractResource: simple.ConfigMap({
            name: schema.spec.name,
            id: 'installationContract',
            data: {
              version: '1.2.3',
              digest: 'sha256:abc',
            },
          }),
        }),
        () => ({
          version: Cel.expr<string>('installationContract.data.version'),
          digest: Cel.expr<string>('installationContract.data.digest'),
        })
      );

      const yaml = graph.toYaml();

      expect(yaml).toContain('version: ${installationContract.data.version}');
      expect(yaml).toContain('digest: ${installationContract.data.digest}');
    });

    it('canonicalizes callback keys for arbitrary top-level resource fields', () => {
      const graph = toResourceGraph(
        {
          name: 'config-data-callback-alias-test',
          apiVersion: 'v1alpha1',
          kind: 'ConfigDataCallbackAlias',
          spec: type({ name: 'string' }),
          status: type({ version: 'string' }),
        },
        (schema) => ({
          contractResource: simple.ConfigMap({
            name: schema.spec.name,
            id: 'installationContract',
            data: { version: '1.2.3' },
          }),
        }),
        () => ({
          version: Cel.expr<string>('contractResource.data.version'),
        })
      );

      const yaml = graph.toYaml();

      expect(yaml).toContain('version: ${installationContract.data.version}');
      expect(yaml).not.toContain('contractResource.data.version');
    });

    it('canonicalizes derived nested aliases for arbitrary top-level resource fields', () => {
      const graph = toResourceGraph(
        {
          name: 'config-data-derived-alias-test',
          apiVersion: 'v1alpha1',
          kind: 'ConfigDataDerivedAlias',
          spec: type({ name: 'string' }),
          status: type({ version: 'string' }),
        },
        (schema) => ({
          outer1InstallationContract: simple.ConfigMap({
            name: schema.spec.name,
            id: 'outer1InstallationContract',
            data: { version: '1.2.3' },
          }),
        }),
        () => ({
          version: Cel.expr<string>('installationContract.data.version'),
        })
      );

      const yaml = graph.toYaml();

      expect(yaml).toContain('version: ${outer1InstallationContract.data.version}');
      expect(yaml).not.toContain('version: ${installationContract.data.version}');
    });

    it('rejects Secret data projections before legacy YAML emission', () => {
      const graph = toResourceGraph(
        {
          name: 'secret-data-status-test',
          apiVersion: 'v1alpha1',
          kind: 'SecretDataStatus',
          spec: type({ name: 'string', token: 'string' }),
          status: type({ token: 'string' }),
        },
        (schema) => ({
          credentials: createResource(
            {
              id: 'credentials',
              apiVersion: 'v1',
              kind: 'Secret',
              metadata: { name: schema.spec.name },
              data: { token: schema.spec.token },
            },
            { factoryName: 'secret' }
          ),
        }),
        () => ({
          token: Cel.expr<string>('credentials.data.token'),
        })
      );

      expect(() => graph.toYaml()).toThrow(
        "Status field 'token' derives from sensitive Secret data and cannot be projected"
      );
    });

    it('rejects Secret aggregates hidden behind CEL conversion functions', () => {
      const graph = toResourceGraph(
        {
          name: 'secret-dyn-status-test',
          apiVersion: 'v1alpha1',
          kind: 'SecretDynStatus',
          spec: type({ name: 'string' }),
          status: type({ token: 'string' }),
        },
        (schema) => ({
          credentials: externalRef({
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
          }),
        }),
        () => ({
          token: Cel.expr<string>('dyn(credentials).data.token'),
        })
      );

      expect(() => graph.toYaml()).toThrow(
        "Status field 'token' derives from sensitive Secret data and cannot be projected"
      );
    });

    it('rejects Secret data in helper-generated mixed templates', () => {
      const secretTemplate = () =>
        Cel.template('prefix-%s', Cel.expr<string>('string(credentials.data.token)'));
      const graph = toResourceGraph(
        {
          name: 'secret-template-status-test',
          apiVersion: 'v1alpha1',
          kind: 'SecretTemplateStatus',
          spec: type({ name: 'string' }),
          status: type({ token: 'string' }),
        },
        (schema) => ({
          credentials: externalRef({
            id: 'credentials',
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: schema.spec.name },
          }),
        }),
        () => ({ token: secretTemplate() })
      );

      expect(() => graph.toYaml()).toThrow(
        "Status field 'token' derives from sensitive Secret data and cannot be projected"
      );
    });

    it('rejects callback aliases that collide with another canonical resource identity', () => {
      expect(() =>
        toResourceGraph(
          {
            name: 'conflicting-status-alias-test',
            apiVersion: 'v1alpha1',
            kind: 'ConflictingStatusAlias',
            spec: type({ name: 'string' }),
            status: type({ version: 'string' }),
          },
          (schema) => ({
            contract: simple.ConfigMap({
              id: 'firstConfig',
              name: `${schema.spec.name}-first`,
              data: { version: '1' },
            }),
            canonicalContract: simple.ConfigMap({
              id: 'contract',
              name: `${schema.spec.name}-canonical`,
              data: { version: '2' },
            }),
          }),
          () => ({
            version: Cel.expr<string>('contract.data.version'),
          })
        )
      ).toThrow(
        "Status resource identity 'contract' is ambiguous between resources " +
          "'firstConfig' and 'contract'"
      );
    });
  });

  // Note: Backward compatibility test removed - automatic schema reference fallbacks
  // are no longer supported. Status fields must be explicitly defined in status builders.
});
