/**
 * Unit tests for __KUBERNETES_REF__ marker to CEL expression conversion
 * 
 * These tests validate the conversion of template literal markers to proper CEL expressions
 * for Kro ResourceGraphDefinitions.
 */

import { describe, it, expect } from 'bun:test';
import { processResourceReferences } from '../../src/utils/helpers.js';

describe('__KUBERNETES_REF__ Marker to CEL Conversion', () => {
  describe('Single Reference Conversion', () => {
    it('should convert a single schema reference marker to CEL expression', () => {
      const input = '__KUBERNETES_REF___schema___spec.name__';
      const result = processResourceReferences(input);
      expect(result).toBe('${schema.spec.name}');
    });

    it('should convert a nested schema reference marker to CEL expression', () => {
      const input = '__KUBERNETES_REF___schema___spec.config.hostname__';
      const result = processResourceReferences(input);
      expect(result).toBe('${schema.spec.config.hostname}');
    });

    it('should convert a resource reference marker to CEL expression', () => {
      const input = '__KUBERNETES_REF_deployment_status.readyReplicas__';
      const result = processResourceReferences(input);
      expect(result).toBe('${deployment.status.readyReplicas}');
    });
  });

  describe('Mixed Content Conversion (Template Literals)', () => {
    it('should convert marker with suffix to CEL concatenation', () => {
      const input = '__KUBERNETES_REF___schema___spec.name__-namespace-policy';
      const result = processResourceReferences(input);
      expect(result).toBe('${schema.spec.name + "-namespace-policy"}');
    });

    it('should convert marker with prefix to CEL concatenation', () => {
      const input = 'prefix-__KUBERNETES_REF___schema___spec.name__';
      const result = processResourceReferences(input);
      expect(result).toBe('${"prefix-" + schema.spec.name}');
    });

    it('should convert marker with both prefix and suffix to CEL concatenation', () => {
      const input = 'app-__KUBERNETES_REF___schema___spec.name__-service';
      const result = processResourceReferences(input);
      expect(result).toBe('${"app-" + schema.spec.name + "-service"}');
    });

    it('should convert multiple markers in a string to CEL concatenation', () => {
      const input = '__KUBERNETES_REF___schema___spec.name__-__KUBERNETES_REF___schema___spec.tier__';
      const result = processResourceReferences(input);
      expect(result).toBe('${schema.spec.name + "-" + schema.spec.tier}');
    });

    it('should handle complex template with multiple markers and text', () => {
      const input = 'https://__KUBERNETES_REF___schema___spec.hostname__:__KUBERNETES_REF___schema___spec.port__/api';
      const result = processResourceReferences(input);
      expect(result).toBe('${"https://" + schema.spec.hostname + ":" + schema.spec.port + "/api"}');
    });
  });

  describe('Object Processing with Markers', () => {
    it('should convert markers in object properties', () => {
      const input = {
        metadata: {
          name: '__KUBERNETES_REF___schema___spec.name__-policy',
          namespace: 'default',
        },
      };
      const result = processResourceReferences(input) as any;
      expect(result.metadata.name).toBe('${schema.spec.name + "-policy"}');
      expect(result.metadata.namespace).toBe('default');
    });

    it('should convert markers in nested object properties', () => {
      const input = {
        spec: {
          selector: {
            matchLabels: {
              app: '__KUBERNETES_REF___schema___spec.appName__',
              tier: '__KUBERNETES_REF___schema___spec.tier__',
            },
          },
        },
      };
      const result = processResourceReferences(input) as any;
      expect(result.spec.selector.matchLabels.app).toBe('${schema.spec.appName}');
      expect(result.spec.selector.matchLabels.tier).toBe('${schema.spec.tier}');
    });

    it('should convert markers in array elements', () => {
      const input = {
        items: [
          '__KUBERNETES_REF___schema___spec.item1__',
          '__KUBERNETES_REF___schema___spec.item2__',
        ],
      };
      const result = processResourceReferences(input) as any;
      expect(result.items[0]).toBe('${schema.spec.item1}');
      expect(result.items[1]).toBe('${schema.spec.item2}');
    });
  });

  describe('Non-Schema Resource References', () => {
    it('should convert resource reference with status field', () => {
      const input = '__KUBERNETES_REF_myDeployment_status.availableReplicas__';
      const result = processResourceReferences(input);
      expect(result).toBe('${myDeployment.status.availableReplicas}');
    });

    it('should convert resource reference with metadata field', () => {
      const input = '__KUBERNETES_REF_service_metadata.name__';
      const result = processResourceReferences(input);
      expect(result).toBe('${service.metadata.name}');
    });

    it('should handle mixed schema and resource references', () => {
      const input = {
        name: '__KUBERNETES_REF___schema___spec.name__-svc',
        clusterIP: '__KUBERNETES_REF_service_status.clusterIP__',
      };
      const result = processResourceReferences(input) as any;
      expect(result.name).toBe('${schema.spec.name + "-svc"}');
      expect(result.clusterIP).toBe('${service.status.clusterIP}');
    });
  });

  describe('Edge Cases', () => {
    it('should not modify strings without markers', () => {
      const input = 'regular-string-without-markers';
      const result = processResourceReferences(input);
      expect(result).toBe('regular-string-without-markers');
    });

    it('should handle empty strings', () => {
      const input = '';
      const result = processResourceReferences(input);
      expect(result).toBe('');
    });

    it('should handle null values', () => {
      const input = null;
      const result = processResourceReferences(input);
      expect(result).toBe(null);
    });

    it('should handle undefined values', () => {
      const input = undefined;
      const result = processResourceReferences(input);
      expect(result).toBe(undefined);
    });

    it('should handle numeric values', () => {
      const input = 8080;
      const result = processResourceReferences(input);
      expect(result).toBe(8080);
    });

    it('should handle boolean values', () => {
      const input = true;
      const result = processResourceReferences(input);
      expect(result).toBe(true);
    });

    it('should preserve objects without markers', () => {
      const input = {
        name: 'static-name',
        port: 8080,
        enabled: true,
      };
      const result = processResourceReferences(input) as any;
      expect(result.name).toBe('static-name');
      expect(result.port).toBe(8080);
      expect(result.enabled).toBe(true);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle CiliumNetworkPolicy metadata.name pattern', () => {
      // This is the exact pattern that was failing before the fix
      const input = {
        apiVersion: 'cilium.io/v2',
        kind: 'CiliumNetworkPolicy',
        metadata: {
          name: '__KUBERNETES_REF___schema___spec.name__-namespace-policy',
          namespace: 'typekro-test-cross-resource',
        },
        spec: {
          endpointSelector: {
            matchLabels: {
              app: '__KUBERNETES_REF___schema___spec.name__',
              tier: '__KUBERNETES_REF___schema___spec.tier__',
            },
          },
        },
      };
      
      const result = processResourceReferences(input) as any;
      
      expect(result.metadata.name).toBe('${schema.spec.name + "-namespace-policy"}');
      expect(result.metadata.namespace).toBe('typekro-test-cross-resource');
      expect(result.spec.endpointSelector.matchLabels.app).toBe('${schema.spec.name}');
      expect(result.spec.endpointSelector.matchLabels.tier).toBe('${schema.spec.tier}');
    });

    it('should handle HelmRelease name pattern', () => {
      const input = {
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        kind: 'HelmRelease',
        metadata: {
          name: '__KUBERNETES_REF___schema___spec.releaseName__',
          namespace: '__KUBERNETES_REF___schema___spec.namespace__',
        },
        spec: {
          chart: {
            spec: {
              chart: '__KUBERNETES_REF___schema___spec.chartName__',
              version: '__KUBERNETES_REF___schema___spec.chartVersion__',
            },
          },
        },
      };
      
      const result = processResourceReferences(input) as any;
      
      expect(result.metadata.name).toBe('${schema.spec.releaseName}');
      expect(result.metadata.namespace).toBe('${schema.spec.namespace}');
      expect(result.spec.chart.spec.chart).toBe('${schema.spec.chartName}');
      expect(result.spec.chart.spec.version).toBe('${schema.spec.chartVersion}');
    });

    it('should handle Service with cross-resource references', () => {
      const input = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: '__KUBERNETES_REF___schema___spec.name__-svc',
        },
        spec: {
          selector: {
            app: '__KUBERNETES_REF___schema___spec.name__',
          },
          ports: [
            {
              port: 80,
              targetPort: '__KUBERNETES_REF___schema___spec.containerPort__',
            },
          ],
        },
      };
      
      const result = processResourceReferences(input) as any;
      
      expect(result.metadata.name).toBe('${schema.spec.name + "-svc"}');
      expect(result.spec.selector.app).toBe('${schema.spec.name}');
      expect(result.spec.ports[0].port).toBe(80);
      expect(result.spec.ports[0].targetPort).toBe('${schema.spec.containerPort}');
    });
  });
});
