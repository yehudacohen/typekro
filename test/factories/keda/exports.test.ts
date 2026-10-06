import { describe, expect, it } from 'bun:test';
import * as keda from '../../../src/factories/keda/index.js';
import * as root from '../../../src/index.js';

describe('typekro/keda exports', () => {
  it('exports the compositions, factories, helpers and constants', () => {
    expect(keda.kedaBootstrap).toBeDefined();
    expect(keda.makeKedaBootstrap).toBeTypeOf('function');
    expect(keda.kedaHelmRepositoryBootstrap).toBeDefined();
    expect(keda.scaledObject).toBeTypeOf('function');
    expect(keda.scaledJob).toBeTypeOf('function');
    expect(keda.triggerAuthentication).toBeTypeOf('function');
    expect(keda.clusterTriggerAuthentication).toBeTypeOf('function');
    expect(keda.kedaTrigger).toBeTypeOf('function');
    expect(keda.kedaReady).toBeTypeOf('function');
    expect(keda.kedaActive).toBeTypeOf('function');
    expect(keda.kedaHelmRepository).toBeTypeOf('function');
    expect(keda.kedaHelmRelease).toBeTypeOf('function');
    expect(keda.mapKedaConfigToHelmValues).toBeTypeOf('function');
    expect(keda.validateScaledObjectSpec).toBeTypeOf('function');
    expect(keda.validateScaledJobSpec).toBeTypeOf('function');
    expect(keda.validateKedaBootstrapConfig).toBeTypeOf('function');
    expect(keda.findKedaAutoscalerConflicts).toBeTypeOf('function');
    expect(keda.DEFAULT_KEDA_CHART_VERSION).toBe('2.21.0');
    expect(keda.DEFAULT_KEDA_REPOSITORY_URL).toBe('https://kedacore.github.io/charts');
    expect(keda.KEDA_API_VERSION).toBe('keda.sh/v1alpha1');
  });

  it('stays out of the root barrel', () => {
    expect(Object.keys(root)).not.toContain('keda');
    expect(Object.keys(root)).not.toContain('kedaBootstrap');
    expect(Object.keys(root)).not.toContain('scaledObject');
  });
});
