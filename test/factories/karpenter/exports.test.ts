import { describe, expect, it } from 'bun:test';

import * as root from '../../../src/index.js';
import * as karpenter from '../../../src/factories/karpenter/index.js';

describe('typekro/karpenter exports', () => {
  it('exports the compositions, factories, helpers and constants', () => {
    expect(karpenter.karpenterBootstrap).toBeDefined();
    expect(karpenter.makeKarpenterBootstrap).toBeTypeOf('function');
    expect(karpenter.karpenterHelmRepositoryBootstrap).toBeDefined();
    expect(karpenter.nodePool).toBeTypeOf('function');
    expect(karpenter.ec2NodeClass).toBeTypeOf('function');
    expect(karpenter.karpenterReady).toBeTypeOf('function');
    expect(karpenter.karpenterHelmRepository).toBeTypeOf('function');
    expect(karpenter.karpenterCrdHelmRelease).toBeTypeOf('function');
    expect(karpenter.karpenterHelmRelease).toBeTypeOf('function');
    expect(karpenter.mapKarpenterConfigToHelmValues).toBeTypeOf('function');
    expect(karpenter.validateNodePoolSpec).toBeTypeOf('function');
    expect(karpenter.validateEC2NodeClassSpec).toBeTypeOf('function');
    expect(karpenter.validateKarpenterBootstrapConfig).toBeTypeOf('function');
    expect(karpenter.DEFAULT_KARPENTER_CHART_VERSION).toBe('1.14.1');
    expect(karpenter.DEFAULT_KARPENTER_REPOSITORY_URL).toBe('oci://public.ecr.aws/karpenter');
    expect(karpenter.KARPENTER_LABELS.capacityType).toBe('karpenter.sh/capacity-type');
  });

  it('stays out of the root barrel', () => {
    expect(Object.keys(root)).not.toContain('karpenter');
    expect(Object.keys(root)).not.toContain('karpenterBootstrap');
    expect(Object.keys(root)).not.toContain('nodePool');
  });
});
