import { describe, expect, it } from 'bun:test';
import packageJson from '../../../package.json' with { type: 'json' };
import * as lbc from '../../../src/factories/aws-load-balancer-controller/index.js';
import * as root from '../../../src/index.js';

describe('typekro/aws-load-balancer-controller exports', () => {
  it('is a subpath export', () => {
    expect(packageJson.exports['./aws-load-balancer-controller']).toEqual({
      import: './dist/factories/aws-load-balancer-controller/index.js',
      types: './dist/factories/aws-load-balancer-controller/index.d.ts',
    });
    expect(typeof lbc.awsLoadBalancerControllerBootstrap).toBe('function');
    expect(typeof lbc.makeAwsLoadBalancerControllerBootstrap).toBe('function');
    expect(typeof lbc.targetGroupBinding).toBe('function');
    expect(typeof lbc.ingressClassParams).toBe('function');
  });

  it('stays out of the root barrel', () => {
    expect(Object.keys(root)).not.toContain('awsLoadBalancerControllerBootstrap');
    expect(Object.keys(root)).not.toContain('awsLoadBalancerController');
  });
});
