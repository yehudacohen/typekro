/**
 * Literal status leaves must not reach a ResourceGraphDefinition (issue #188).
 *
 * KRO fills an instance's status only from expressions it can resolve against
 * the graph's own resources. A leaf that is a bare literal is left unset, so
 * the CRD advertises a field the custom resource never carries and every
 * consumer reading the CR directly gets `undefined`. TypeKro used to classify
 * those leaves as "static" and hydrate them client-side in `getStatus()`, which
 * hid the gap from the composition's author and from nobody else.
 *
 * These tests pin the diagnostic: which leaves are rejected, that the message
 * names the exact status path, that a projection is accepted, and that direct
 * mode — which assembles status locally and has no reconciler — is untouched.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, kubernetesComposition, simple } from '../../src/index.js';
import type { SerializationOptions } from '../../src/core/types/serialization.js';
import {
  DEFAULT_ALLOW_LITERAL_STATUS,
  findLiteralStatusLeaves,
  resolveAllowLiteralStatus,
} from '../../src/core/validation/literal-status.js';

const STRICT: SerializationOptions = { allowLiteralStatus: false };

const specSchema = type({ name: 'string', replicas: 'number%1' });

/**
 * Build a composition whose status is exactly `buildStatus(...)`.
 *
 * Every case below needs the same deployment to project from, so the resource
 * half is shared and only the status half varies.
 */
function composition<TStatus extends Record<string, unknown>>(
  name: string,
  statusSchema: ReturnType<typeof type>,
  buildStatus: (deployment: ReturnType<typeof simple.Deployment>) => TStatus,
  options: SerializationOptions = STRICT
) {
  return kubernetesComposition(
    {
      name,
      apiVersion: 'example.com/v1alpha1',
      kind: 'LiteralStatusProbe',
      spec: specSchema,
      status: statusSchema as never,
    },
    (spec) => {
      const deployment = simple.Deployment({
        name: spec.name,
        image: 'nginx',
        replicas: spec.replicas,
        id: 'probeDeployment',
      });
      return buildStatus(deployment) as never;
    },
    options
  );
}

/** The thrown diagnostic, or `undefined` if serialization succeeded. */
function serializationError(graph: { toYaml: () => string }): string | undefined {
  try {
    graph.toYaml();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('literal status leaves (#188)', () => {
  describe('rejected in KRO mode', () => {
    it('names a top-level literal leaf', () => {
      const graph = composition(
        'literal-top-level',
        type({ ready: 'boolean', url: 'string' }),
        (deployment) => ({
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: 'http://static.example.test',
        })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.url = "http://static.example.test"');
      // The projected sibling is fine and must not be dragged in.
      expect(message).not.toContain('status.ready');
    });

    it('names a leaf nested inside a status object', () => {
      const graph = composition(
        'literal-nested',
        type({ info: { mode: 'string', replicas: 'number%1' } }),
        (deployment) => ({
          info: { mode: 'standalone', replicas: deployment.status.readyReplicas },
        })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.info.mode = "standalone"');
      expect(message).not.toContain('status.info.replicas');
    });

    it('names each literal element of a status array by index', () => {
      const graph = composition(
        'literal-in-array',
        type({ entrypoints: 'string[]' }),
        () => ({ entrypoints: ['web', 'websecure'] })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.entrypoints[0] = "web"');
      expect(message).toContain('status.entrypoints[1] = "websecure"');
    });

    it('reports every literal in a mixed object, and only those', () => {
      const graph = composition(
        'literal-mixed',
        type({
          ready: 'boolean',
          endpoints: { api: { scheme: 'string', port: 'number%1' } },
          replicas: 'number%1',
        }),
        (deployment) => ({
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          endpoints: { api: { scheme: 'http', port: 8080 } },
          replicas: deployment.status.readyReplicas,
        })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.endpoints.api.scheme = "http"');
      expect(message).toContain('status.endpoints.api.port = 8080');
      expect(message).not.toContain('status.ready');
      expect(message).not.toContain('status.replicas');
    });

    it('rejects a reference-free CEL expression, which KRO drops just the same', () => {
      const graph = composition('literal-cel', type({ phase: 'string' }), () => ({
        phase: Cel.expr<string>`'running'`,
      }));

      expect(serializationError(graph)).toContain('status.phase');
    });

    it('suggests projecting from an owned resource or removing the field', () => {
      const graph = composition('literal-suggestion', type({ url: 'string' }), () => ({
        url: 'http://static.example.test',
      }));

      const message = serializationError(graph);
      expect(message).toContain('Project each leaf from a resource this graph owns');
      expect(message).toContain('remove the field from the status schema');
      expect(message).toContain('allowLiteralStatus');
    });
  });

  describe('accepted in KRO mode', () => {
    it('passes when every leaf projects from a resource or the schema spec', () => {
      const graph = composition(
        'all-projections',
        type({
          ready: 'boolean',
          replicas: 'number%1',
          name: 'string',
          info: { available: 'number%1' },
        }),
        (deployment) => ({
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          replicas: deployment.status.readyReplicas,
          name: deployment.metadata.name,
          info: { available: deployment.status.availableReplicas },
        })
      );

      expect(serializationError(graph)).toBeUndefined();
      // And the projections survive into the emitted RGD.
      expect(graph.toYaml()).toContain('probeDeployment.status.readyReplicas');
    });
  });

  describe('direct mode', () => {
    it('serializes literals without complaint — status is assembled locally there', () => {
      const graph = composition(
        'direct-mode-literals',
        type({ ready: 'boolean', url: 'string' }),
        () => ({ ready: true, url: 'http://static.example.test' }),
        // Strict, to prove the check is scoped to the KRO emitter rather than
        // merely defaulted off.
        STRICT
      );

      const yaml = graph.factory('direct').toYaml({ name: 'probe', replicas: 1 });
      expect(yaml).toBeTruthy();
    });
  });

  describe('escape hatch', () => {
    it('serializes and keeps the literal paths on the schema when allowed', () => {
      const graph = composition(
        'escape-hatch',
        type({ ready: 'boolean', url: 'string' }),
        (deployment) => ({
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          url: 'http://static.example.test',
        }),
        { allowLiteralStatus: true }
      );

      expect(serializationError(graph)).toBeUndefined();
    });

    it('a factory-level setting overrides the composition, so CI can enforce projection', () => {
      const graph = composition(
        'factory-override',
        type({ url: 'string' }),
        () => ({ url: 'http://static.example.test' }),
        { allowLiteralStatus: true }
      );

      expect(() => graph.factory('kro', { allowLiteralStatus: false }).toYaml()).toThrow(
        /status\.url/
      );
    });
  });

  describe('resolveAllowLiteralStatus', () => {
    it('prefers the factory setting, then the composition, then the default', () => {
      expect(resolveAllowLiteralStatus(false, true)).toBe(false);
      expect(resolveAllowLiteralStatus(true, false)).toBe(true);
      expect(resolveAllowLiteralStatus(undefined, false)).toBe(false);
      expect(resolveAllowLiteralStatus(undefined, undefined)).toBe(DEFAULT_ALLOW_LITERAL_STATUS);
    });
  });

  describe('findLiteralStatusLeaves', () => {
    it('does not read a plain status string as a CEL reference', () => {
      // `celRootReferences` would parse this URL's dots as identifier paths and
      // report four "references"; a plain string is data, not an expression.
      const leaves = findLiteralStatusLeaves({ url: 'http://static.example.test' });
      expect(leaves.map((leaf) => leaf.path)).toEqual(['status.url']);
    });

    it('reports an empty array or object as the dropped field itself', () => {
      const leaves = findLiteralStatusLeaves({ entrypoints: [], labels: {} });
      expect(leaves.map((leaf) => `${leaf.path} = ${leaf.literal}`)).toEqual([
        'status.entrypoints = []',
        'status.labels = {}',
      ]);
    });

    it('ignores internal serialization metadata keys', () => {
      const leaves = findLiteralStatusLeaves({ __internal: 'anything', ready: true });
      expect(leaves.map((leaf) => leaf.path)).toEqual(['status.ready']);
    });

    it('returns nothing for an absent status mapping', () => {
      expect(findLiteralStatusLeaves(undefined)).toEqual([]);
    });
  });
});
