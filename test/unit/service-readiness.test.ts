/**
 * Test suite for service factory with readiness evaluation
 */

import { describe, expect, it } from 'bun:test';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import type { V1Service } from '@kubernetes/client-node';

describe('Service Factory with Readiness Evaluation', () => {
  it('should create service with readiness evaluator', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'ClusterIP',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    
    expect(enhanced).toBeDefined();
    expect((enhanced as any).readinessEvaluator).toBeDefined();
    expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
  });

  it('should evaluate ClusterIP service as ready immediately', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'ClusterIP',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const result = evaluator({ spec: { type: 'ClusterIP' } });
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('ClusterIP service is ready');
  });

  it('should evaluate NodePort service as ready immediately', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'NodePort',
        ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const result = evaluator({ spec: { type: 'NodePort' } });
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('NodePort service is ready');
  });

  it('should evaluate LoadBalancer service as not ready when ingress is missing', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const liveResource = {
      spec: { type: 'LoadBalancer' },
      status: { loadBalancer: {} }
    };
    
    const result = evaluator(liveResource);
    
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('LoadBalancerPending');
    expect(result.message).toContain('Waiting for LoadBalancer');
    expect(result.details?.serviceType).toBe('LoadBalancer');
  });

  it('should evaluate LoadBalancer service as ready when ingress has IP', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const liveResource = {
      spec: { type: 'LoadBalancer' },
      status: {
        loadBalancer: {
          ingress: [{ ip: '192.168.1.100' }]
        }
      }
    };
    
    const result = evaluator(liveResource);
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('external endpoint: 192.168.1.100');
  });

  it('should evaluate LoadBalancer service as ready when ingress has hostname', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const liveResource = {
      spec: { type: 'LoadBalancer' },
      status: {
        loadBalancer: {
          ingress: [{ hostname: 'test-lb.example.com' }]
        }
      }
    };
    
    const result = evaluator(liveResource);
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('external endpoint: test-lb.example.com');
  });

  it('should evaluate ExternalName service as ready when externalName is set', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'ExternalName',
        externalName: 'external-service.example.com'
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const liveResource = {
      spec: { 
        type: 'ExternalName',
        externalName: 'external-service.example.com'
      }
    };
    
    const result = evaluator(liveResource);
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('external-service.example.com');
  });

  it('should evaluate ExternalName service as not ready when externalName is missing', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'ExternalName'
        // externalName is missing
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const liveResource = {
      spec: { type: 'ExternalName' }
    };
    
    const result = evaluator(liveResource);
    
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('ExternalNameMissing');
    expect(result.message).toContain('missing externalName field');
    expect(result.details?.serviceType).toBe('ExternalName');
  });

  it('should handle default service type (ClusterIP)', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        // No type specified, should default to ClusterIP
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    const result = evaluator({ spec: {} });
    
    expect(result.ready).toBe(true);
    expect(result.message).toContain('ClusterIP service is ready');
  });

  it('should handle evaluation errors gracefully', () => {
    const serviceResource: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'test-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'test' }
      }
    };

    const enhanced = service(serviceResource);
    const evaluator = (enhanced as any).readinessEvaluator;
    
    // Pass malformed resource that might cause errors
    const result = evaluator(null);
    
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('EvaluationError');
    expect(result.message).toContain('Error evaluating service readiness');
    expect(result.details?.serviceType).toBe('LoadBalancer');
  });
});