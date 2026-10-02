import { describe, expect, it } from 'bun:test';

import * as root from '../../../src/index.js';
import * as vpa from '../../../src/factories/vpa/index.js';

describe('typekro/vpa exports', () => {
  it('exports the compositions, factories, helpers and constants', () => {
    expect(vpa.vpaBootstrap).toBeDefined();
    expect(vpa.makeVpaBootstrap).toBeTypeOf('function');
    expect(vpa.vpaHelmRepositoryBootstrap).toBeDefined();
    expect(vpa.verticalPodAutoscaler).toBeTypeOf('function');
    expect(vpa.vpaRecommendOnly).toBeTypeOf('function');
    expect(vpa.vpaRecommendationProvided).toBeTypeOf('function');
    expect(vpa.vpaHelmRepository).toBeTypeOf('function');
    expect(vpa.vpaHelmRelease).toBeTypeOf('function');
    expect(vpa.mapVpaConfigToHelmValues).toBeTypeOf('function');
    expect(vpa.validateVerticalPodAutoscalerSpec).toBeTypeOf('function');
    expect(vpa.validateVpaBootstrapConfig).toBeTypeOf('function');
    expect(vpa.findVpaAutoscalerConflicts).toBeTypeOf('function');
    expect(vpa.DEFAULT_VPA_CHART_VERSION).toBe('5.1.0');
    expect(vpa.DEFAULT_VPA_REPOSITORY_URL).toBe('https://charts.fairwinds.com/stable');
    expect(vpa.VPA_API_VERSION).toBe('autoscaling.k8s.io/v1');
  });

  it('stays out of the root barrel', () => {
    expect(Object.keys(root)).not.toContain('vpa');
    expect(Object.keys(root)).not.toContain('vpaBootstrap');
    expect(Object.keys(root)).not.toContain('verticalPodAutoscaler');
  });
});
