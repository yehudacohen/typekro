/**
 * Dropped status leaves must not reach a ResourceGraphDefinition (issue #188).
 *
 * KRO fills an instance's status only from expressions anchored on the graph's
 * own resources — `instance status field must refer to a resource`. A leaf that
 * references no resource is left unset, so the CRD advertises a field the
 * custom resource never carries and every consumer reading the CR directly gets
 * `undefined`. TypeKro used to classify those leaves as "static" and hydrate
 * them client-side in `getStatus()`, which hid the gap from the composition's
 * author and from nobody else.
 *
 * Two shapes reference no resource, and KRO drops both: a bare LITERAL, and a
 * bare `schema.spec.*` SCHEMA REFERENCE (the instance's own spec is not a
 * resource, and KRO's status CEL has no `schema` identifier at all). A
 * `schema.spec.*` inside an expression that ALSO references a resource is fine
 * — the resource supplies the dependency KRO requires.
 *
 * These tests pin the diagnostic: which leaves are rejected, that the message
 * names the exact status path, that a projection is accepted, and that direct
 * mode — which assembles status locally and has no reconciler — is untouched.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, kubernetesComposition, simple } from '../../src/index.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';
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
  buildStatus: (
    deployment: ReturnType<typeof simple.Deployment>,
    spec: typeof specSchema.infer
  ) => TStatus,
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
      return buildStatus(deployment, spec as typeof specSchema.infer) as never;
    },
    options
  );
}

/** A minimal branded CEL expression, for driving the walker directly. */
function cel(expression: string): Record<PropertyKey, unknown> {
  return { [CEL_EXPRESSION_BRAND]: true, expression };
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

  /**
   * A `schema.spec.*` reference standing alone in a status leaf is dropped by
   * exactly the same mechanism as a literal: KRO requires each status field to
   * refer to a RESOURCE, and the instance's own spec is not one. The rest of
   * this codebase already says so in three places — invariant I2 in
   * `nested-composition-kro-serialization.test.ts` ("KRO status CEL does NOT
   * support `schema.spec.*`"), the drop described in
   * `src/core/proxy/create-resource.ts`, and `assertNoHoistWeakenedStatusFields`,
   * which THROWS for this shape when a hoisted Namespace leaves a field
   * schema-only. These tests make the general check agree with all three.
   */
  describe('bare schema references in KRO mode', () => {
    it('names a top-level schema.spec leaf', () => {
      const graph = composition(
        'schema-ref-top-level',
        type({ name: 'string', ready: 'boolean' }),
        (deployment, spec) => ({
          name: spec.name,
          ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
        })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.name = schema.spec.name');
      expect(message).toContain('schema reference');
      // The resource-projected sibling is fine and must not be dragged in.
      expect(message).not.toContain('status.ready');
    });

    it('names a schema.spec leaf nested inside a status object', () => {
      const graph = composition(
        'schema-ref-nested',
        type({ info: { name: 'string', replicas: 'number%1' } }),
        (deployment, spec) => ({
          info: { name: spec.name, replicas: deployment.status.readyReplicas },
        })
      );

      const message = serializationError(graph);
      expect(message).toContain('status.info.name = schema.spec.name');
      expect(message).not.toContain('status.info.replicas');
    });

    it('explains that the value must be projected through an owned resource', () => {
      const graph = composition('schema-ref-suggestion', type({ name: 'string' }), (_d, spec) => ({
        name: spec.name,
      }));

      const message = serializationError(graph);
      expect(message).toContain('KRO requires every status field to refer to a resource');
      expect(message).toContain('echo it into a ConfigMap');
    });

    it('classifies a bare schema ref as a schema reference, not a literal', () => {
      const leaves = findLiteralStatusLeaves({
        name: cel('schema.spec.name'),
      });
      expect(leaves.map((leaf) => ({ path: leaf.path, kind: leaf.kind }))).toEqual([
        { path: 'status.name', kind: 'schema-reference' },
      ]);
    });

    it('flags a raw __schema__ KubernetesRef reaching the walk directly', () => {
      // The analyzer normally converts these to CEL before serialization; the
      // ref shape is handled too so a path that skips conversion cannot slip a
      // schema-only leaf through.
      const schemaRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath: 'spec.name',
      };
      const leaves = findLiteralStatusLeaves({ name: schemaRef });
      expect(leaves).toEqual([
        { path: 'status.name', literal: 'schema.spec.name', kind: 'schema-reference' },
      ]);
    });

    it('does not flag a resource ref, which is a real projection', () => {
      const resourceRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'probeDeployment',
        fieldPath: 'status.readyReplicas',
      };
      expect(findLiteralStatusLeaves({ replicas: resourceRef })).toEqual([]);
    });

    it('propagates through a nested composition whose status is a spec passthrough', () => {
      // Flattening an inner composition into the outer RGD does not give its
      // schema-only field a resource to project from, so the outer leaf is
      // dropped exactly as the inner one would have been.
      const innerComp = kubernetesComposition(
        {
          name: 'inner-passthrough',
          apiVersion: 'example.com/v1alpha1',
          kind: 'InnerProbe',
          spec: type({ name: 'string' }),
          status: type({ appName: 'string', ready: 'boolean' }) as never,
        },
        (spec) => {
          const deployment = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            replicas: 1,
            id: 'innerDeployment',
          });
          return {
            appName: spec.name,
            ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
          } as never;
        }
      );

      const outerComp = kubernetesComposition(
        {
          name: 'outer-passthrough',
          apiVersion: 'example.com/v1alpha1',
          kind: 'OuterProbe',
          spec: type({ name: 'string' }),
          status: type({ appName: 'string', ready: 'boolean' }) as never,
        },
        (spec) => {
          const inner = innerComp({ name: spec.name }) as unknown as {
            status: { appName: string; ready: boolean };
          };
          return { appName: inner.status.appName, ready: inner.status.ready } as never;
        },
        STRICT
      );

      const message = serializationError(outerComp);
      expect(message).toContain('status.appName = schema.spec.name');
      expect(message).toContain('schema reference');
      // The inner field that IS resource-anchored survives the flattening.
      expect(message).not.toContain('status.ready');
    });

    it('flags a schema-only nested status expression at the unit level', () => {
      const schemaRef = {
        [KUBERNETES_REF_BRAND]: true,
        __nestedComposition: true,
        resourceId: 'innerComp',
        fieldPath: 'status.appName',
      };
      const leaves = findLiteralStatusLeaves({ appName: schemaRef }, {
        '__nestedStatus:innerComp:appName': 'schema.spec.name',
        '__nestedStatus:innerComp:ready': 'innerDeployment.status.readyReplicas > 0',
      });
      expect(leaves).toEqual([
        { path: 'status.appName', literal: 'schema.spec.name', kind: 'schema-reference' },
      ]);
    });

    it('reports a spec-only template as the author wrote it, not as ref markers', () => {
      // Template-literal analysis leaves TypeKro's internal `__KUBERNETES_REF_`
      // encoding in the value. Printing that raw would read as a TypeKro bug
      // rather than as a description of the author's own status field.
      const graph = composition('schema-ref-template', type({ url: 'string' }), (_d, spec) => ({
        url: `http://${spec.name}:8080`,
      }));

      const message = serializationError(graph);
      expect(message).toContain('status.url = http://${schema.spec.name}:8080');
      expect(message).not.toContain('__KUBERNETES_REF_');
    });
  });

  /**
   * The rule is "does this leaf reference a RESOURCE", not "does it mention
   * `schema`". A resource reference anywhere in the expression supplies the
   * dependency KRO requires, and `schema.spec.*` resolves against the
   * instance's own spec from there — which is why the serializer deliberately
   * preserves those refs ("Plain CR spec fields must remain `schema.spec.*`",
   * `cel-references.ts`) and `nested-composition-kro-serialization.test.ts`
   * pins the emitted mixed template.
   */
  describe('a resource reference anchors the leaf', () => {
    it('accepts a template mixing a resource ref with a schema.spec ref', () => {
      const graph = composition(
        'anchored-template',
        type({ url: 'string' }),
        (deployment, spec) => ({
          url: `http://${spec.name}-svc:${deployment.status.readyReplicas}`,
        })
      );

      expect(serializationError(graph)).toBeUndefined();
      // The resource reference really is what survives into the RGD.
      expect(graph.toYaml()).toContain('probeDeployment.status.readyReplicas');
    });

    it('accepts Cel.expr over a resource ref', () => {
      const graph = composition('anchored-cel', type({ ready: 'boolean' }), (deployment) => ({
        ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      }));

      expect(serializationError(graph)).toBeUndefined();
    });

    it('accepts a mixed expression at the unit level, both spellings of the root', () => {
      for (const expression of [
        'probeDeployment.status.readyReplicas > 0 ? schema.spec.name : "none"',
        'probeDeployment.status.readyReplicas > 0 ? __schema__.spec.name : "none"',
      ]) {
        expect(
          findLiteralStatusLeaves({ name: cel(expression) })
        ).toEqual([]);
      }
    });
  });

  describe('accepted in KRO mode', () => {
    it('passes when every leaf projects from a resource', () => {
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
