/**
 * Unit tests for __KUBERNETES_REF__ marker to CEL expression conversion
 *
 * These tests validate the conversion of template literal markers to proper CEL expressions
 * for Kro ResourceGraphDefinitions.
 */

import { describe, expect, it } from 'bun:test';
import { processResourceReferences } from '../../src/core/serialization/cel-references.js';

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
    it('should convert marker with suffix to mixed template with string()', () => {
      const input = '__KUBERNETES_REF___schema___spec.name__-namespace-policy';
      const result = processResourceReferences(input);
      expect(result).toBe('${string(schema.spec.name)}-namespace-policy');
    });

    it('should convert marker with prefix to mixed template with string()', () => {
      const input = 'prefix-__KUBERNETES_REF___schema___spec.name__';
      const result = processResourceReferences(input);
      expect(result).toBe('prefix-${string(schema.spec.name)}');
    });

    it('should convert marker with both prefix and suffix to mixed template with string()', () => {
      const input = 'app-__KUBERNETES_REF___schema___spec.name__-service';
      const result = processResourceReferences(input);
      expect(result).toBe('app-${string(schema.spec.name)}-service');
    });

    it('should convert multiple markers in a string to mixed template with string()', () => {
      const input =
        '__KUBERNETES_REF___schema___spec.name__-__KUBERNETES_REF___schema___spec.tier__';
      const result = processResourceReferences(input);
      expect(result).toBe('${string(schema.spec.name)}-${string(schema.spec.tier)}');
    });

    it('should handle complex template with multiple markers and text', () => {
      const input =
        'https://__KUBERNETES_REF___schema___spec.hostname__:__KUBERNETES_REF___schema___spec.port__/api';
      const result = processResourceReferences(input);
      expect(result).toBe('https://${string(schema.spec.hostname)}:${string(schema.spec.port)}/api');
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
      const result = processResourceReferences(input) as Record<string, Record<string, unknown>>;
      expect(result.metadata!.name).toBe('${string(schema.spec.name)}-policy');
      expect(result.metadata!.namespace).toBe('default');
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
      const result = processResourceReferences(input) as Record<string, unknown>;
      const spec = result.spec as Record<string, unknown>;
      const matchLabels = (spec.selector as Record<string, unknown>).matchLabels as Record<
        string,
        unknown
      >;
      expect(matchLabels.app).toBe('${schema.spec.appName}');
      expect(matchLabels.tier).toBe('${schema.spec.tier}');
    });

    it('should convert markers in array elements', () => {
      const input = {
        items: [
          '__KUBERNETES_REF___schema___spec.item1__',
          '__KUBERNETES_REF___schema___spec.item2__',
        ],
      };
      const result = processResourceReferences(input) as Record<string, unknown[]>;
      expect(result.items![0]).toBe('${schema.spec.item1}');
      expect(result.items![1]).toBe('${schema.spec.item2}');
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
      const result = processResourceReferences(input) as Record<string, unknown>;
      expect(result.name).toBe('${string(schema.spec.name)}-svc');
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
      const result = processResourceReferences(input) as Record<string, unknown>;
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

      const result = processResourceReferences(input) as Record<string, unknown>;
      const metadata = result.metadata as Record<string, unknown>;
      const spec = result.spec as Record<string, unknown>;
      const endpointSelector = spec.endpointSelector as Record<string, unknown>;
      const matchLabels = endpointSelector.matchLabels as Record<string, unknown>;

      expect(metadata.name).toBe('${string(schema.spec.name)}-namespace-policy');
      expect(metadata.namespace).toBe('typekro-test-cross-resource');
      expect(matchLabels.app).toBe('${schema.spec.name}');
      expect(matchLabels.tier).toBe('${schema.spec.tier}');
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

      const result = processResourceReferences(input) as Record<string, unknown>;
      const metadata = result.metadata as Record<string, unknown>;
      const spec = result.spec as Record<string, unknown>;
      const chart = spec.chart as Record<string, unknown>;
      const chartSpec = chart.spec as Record<string, unknown>;

      expect(metadata.name).toBe('${schema.spec.releaseName}');
      expect(metadata.namespace).toBe('${schema.spec.namespace}');
      expect(chartSpec.chart).toBe('${schema.spec.chartName}');
      expect(chartSpec.version).toBe('${schema.spec.chartVersion}');
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

      const result = processResourceReferences(input) as Record<string, unknown>;
      const metadata = result.metadata as Record<string, unknown>;
      const spec = result.spec as Record<string, unknown>;
      const selector = spec.selector as Record<string, unknown>;
      const ports = spec.ports as Record<string, unknown>[];

      expect(metadata.name).toBe('${string(schema.spec.name)}-svc');
      expect(selector.app).toBe('${schema.spec.name}');
      expect(ports[0]!.port).toBe(80);
      expect(ports[0]!.targetPort).toBe('${schema.spec.containerPort}');
    });
  });
});
