import { describe, expect, it } from 'bun:test';
import { simpleDeployment, simpleHpa, toResourceGraph } from '../../src/index';

describe('HPA Factory', () => {
  it('should create HPA without type assertions', () => {
    const _webapp = simpleDeployment({
      name: 'test-app',
      image: 'nginx:latest',
      replicas: 2,
    });

    const hpa = simpleHpa({
      name: 'test-hpa',
      target: { name: 'test-app', kind: 'Deployment' },
      minReplicas: 1,
      maxReplicas: 10,
      cpuUtilization: 70,
    });

    // Verify HPA was created successfully
    expect(hpa).toBeDefined();
    expect(hpa.metadata?.name).toBe('test-hpa');
    expect(hpa.spec).toBeDefined();
  });

  it('should handle CPU utilization configuration properly', () => {
    const hpa = simpleHpa({
      name: 'cpu-hpa',
      target: { name: 'my-app', kind: 'Deployment' },
      minReplicas: 2,
      maxReplicas: 20,
      cpuUtilization: 80,
    });

    // Verify the spec contains the expected values
    expect(hpa.spec?.minReplicas).toBe(2);
    expect(hpa.spec?.maxReplicas).toBe(20);
    expect(hpa.spec?.scaleTargetRef?.name).toBe('my-app');
    expect(hpa.spec?.scaleTargetRef?.kind).toBe('Deployment');
    expect(hpa.spec?.scaleTargetRef?.apiVersion).toBe('apps/v1');

    // Verify V2 metrics are properly configured
    expect(hpa.spec?.metrics).toBeDefined();
    expect(hpa.spec?.metrics).toHaveLength(1);
    expect(hpa.spec?.metrics?.[0]?.type).toBe('Resource');
    expect(hpa.spec?.metrics?.[0]?.resource?.name).toBe('cpu');
    expect(hpa.spec?.metrics?.[0]?.resource?.target?.type).toBe('Utilization');
    expect(hpa.spec?.metrics?.[0]?.resource?.target?.averageUtilization).toBe(80);
  });

  it('should work without CPU utilization specified', async () => {
    const hpa = simpleHpa({
      name: 'basic-hpa',
      target: { name: 'basic-app', kind: 'Deployment' },
      minReplicas: 1,
      maxReplicas: 5,
    });

    // Should still create a valid HPA
    expect(hpa).toBeDefined();
    expect(hpa.spec?.minReplicas).toBe(1);
    expect(hpa.spec?.maxReplicas).toBe(5);

    // Test serialization to verify metrics are not included
    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'basic-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ hpa }),
      () => ({ name: 'test-status' })
    );
    const yaml = resourceGraph.toYaml();
    expect(yaml).toContain('basic-hpa');
    expect(yaml).toContain('HorizontalPodAutoscaler');
    // Should not contain metrics configuration when CPU utilization is not specified
    expect(yaml).not.toContain('metrics:');
  });

  it('should serialize HPA correctly in resource graph', async () => {
    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    const hpa = simpleHpa({
      name: 'web-hpa',
      target: { name: 'web-app', kind: 'Deployment' },
      minReplicas: 1,
      maxReplicas: 10,
      cpuUtilization: 75,
    });

    // Should serialize without errors
    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp, hpa }),
      () => ({ name: 'test-status' })
    );
    const yaml = resourceGraph.toYaml();
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('web-hpa');
    expect(yaml).toContain('HorizontalPodAutoscaler');
    expect(yaml).toContain('autoscaling/v2'); // Should use V2 API
  });

  it('should support cross-resource references', async () => {
    const webapp = simpleDeployment({
      name: 'ref-app',
      image: 'nginx:latest',
    });

    const hpa = simpleHpa({
      name: 'ref-hpa',
      target: {
        name: webapp.metadata?.name || 'fallback',
        kind: 'Deployment',
      },
      minReplicas: 1,
      maxReplicas: 10,
      cpuUtilization: 70,
    });

    // The target name should reference the deployment
    expect(hpa.spec?.scaleTargetRef?.name).toBe('ref-app');
  });

  it('should demonstrate V2 API benefits over V1', () => {
    // V2 API allows for more sophisticated metrics configuration
    const hpa = simpleHpa({
      name: 'advanced-hpa',
      target: { name: 'advanced-app', kind: 'Deployment' },
      minReplicas: 1,
      maxReplicas: 100,
      cpuUtilization: 60,
    });

    // V2 spec should have metrics array (not just targetCPUUtilizationPercentage)
    expect(hpa.spec?.metrics).toBeDefined();
    expect(Array.isArray(hpa.spec?.metrics)).toBe(true);

    // Should support complex metric configurations
    const cpuMetric = hpa.spec?.metrics?.[0];
    expect(cpuMetric?.type).toBe('Resource');
    expect(cpuMetric?.resource).toBeDefined();
    expect(cpuMetric?.resource?.name).toBe('cpu');
    expect(cpuMetric?.resource?.target).toBeDefined();
    expect(cpuMetric?.resource?.target?.type).toBe('Utilization');
    expect(cpuMetric?.resource?.target?.averageUtilization).toBe(60);

    // V2 API provides extensibility for future metric types
    // (memory, custom metrics, external metrics, etc.)
  });
});
