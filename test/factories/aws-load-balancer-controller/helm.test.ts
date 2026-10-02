import { describe, expect, it } from 'bun:test';
import {
  AWS_LBC_CHART_NAME,
  awsLoadBalancerControllerHelmRelease,
  awsLoadBalancerControllerHelmReleaseReadinessEvaluator,
  awsLoadBalancerControllerHelmRepository,
  DEFAULT_AWS_LBC_CHART_VERSION,
  DEFAULT_AWS_LBC_REPOSITORY_NAME,
  DEFAULT_AWS_LBC_REPOSITORY_URL,
} from '../../../src/factories/aws-load-balancer-controller/index.js';

describe('awsLoadBalancerControllerHelmRepository', () => {
  it('points at eks-charts in flux-system by default', () => {
    const repo = awsLoadBalancerControllerHelmRepository();
    expect(repo.metadata.name).toBe(DEFAULT_AWS_LBC_REPOSITORY_NAME);
    expect(repo.metadata.namespace).toBe('flux-system');
    expect(repo.spec.url).toBe(DEFAULT_AWS_LBC_REPOSITORY_URL);
    expect(repo.spec.interval).toBe('1h');
  });

  it('accepts a mirror URL and name', () => {
    const repo = awsLoadBalancerControllerHelmRepository({
      name: 'eks-mirror',
      url: 'https://charts.example.com/eks',
    });
    expect(repo.metadata.name).toBe('eks-mirror');
    expect(repo.spec.url).toBe('https://charts.example.com/eks');
  });
});

describe('awsLoadBalancerControllerHelmRelease', () => {
  it('pins the chart and installs into kube-system with a fixed release name', () => {
    const release = awsLoadBalancerControllerHelmRelease({ name: 'aws-load-balancer-controller' });
    expect(release.metadata.namespace).toBe('flux-system');
    expect(release.spec.chart.spec.chart).toBe(AWS_LBC_CHART_NAME);
    expect(release.spec.chart.spec.version).toBe(DEFAULT_AWS_LBC_CHART_VERSION);
    expect(release.spec.chart.spec.sourceRef).toEqual({
      kind: 'HelmRepository',
      name: DEFAULT_AWS_LBC_REPOSITORY_NAME,
      namespace: 'flux-system',
    });
    expect(release.spec.targetNamespace).toBe('kube-system');
    expect(release.spec.releaseName).toBe('aws-load-balancer-controller');
  });

  it('replaces the chart CRDs on install and upgrade, with bounded retries', () => {
    const { spec } = awsLoadBalancerControllerHelmRelease({ name: 'lbc' });
    expect(spec.install).toEqual({
      timeout: '10m',
      remediation: { retries: 3 },
      createNamespace: true,
      crds: 'CreateReplace',
    });
    expect(spec.upgrade).toEqual({
      timeout: '10m',
      remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      crds: 'CreateReplace',
    });
  });

  it('lets every lifecycle field be overridden', () => {
    const { spec } = awsLoadBalancerControllerHelmRelease({
      name: 'lbc',
      install: { crds: 'Create', timeout: '20m' },
      upgrade: { crds: 'Skip', remediation: { retries: 0 } },
      driftDetection: { mode: 'warn' },
    });
    expect(spec.install).toMatchObject({ crds: 'Create', timeout: '20m', createNamespace: true });
    expect(spec.upgrade).toMatchObject({
      crds: 'Skip',
      remediation: { retries: 0, remediateLastFailure: true, strategy: 'rollback' },
    });
    expect(spec.driftDetection).toEqual({ mode: 'warn' });
  });

  it('passes values through and uses the Flux readiness evaluator', () => {
    const release = awsLoadBalancerControllerHelmRelease({
      name: 'lbc',
      version: '3.4.0',
      targetNamespace: 'aws-lbc',
      values: { clusterName: 'prod' },
    });
    expect(release.spec.chart.spec.version).toBe('3.4.0');
    expect(release.spec.targetNamespace).toBe('aws-lbc');
    expect(release.spec.values).toEqual({ clusterName: 'prod' });
    expect(release.readinessEvaluator).toBe(awsLoadBalancerControllerHelmReleaseReadinessEvaluator);
  });
});
