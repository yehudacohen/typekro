/**
 * Regression tests for `basePath === 'metadata'` in the resource proxy's status-builder branch
 * (`src/core/proxy/create-resource.ts`).
 *
 * THE BUG: reading `someResource.metadata.name` (or `.namespace`) inside a status builder
 * returned whatever value the resource's own template stored for that field — e.g.
 * `simple.Deployment({ name: spec.name, ... })` stores the SCHEMA ref itself in
 * `metadata.name`, so `deployment.metadata.name` inside a status field silently returned
 * `schema.spec.name` instead of a resource-anchored ref (`deployment.metadata.name`). That broke
 * two things: (1) KRO-mode serialization classifies a schema-derived status field as static and
 * DROPS it from the live KRO CR's status entirely, even though `metadata.name` genuinely IS live
 * resource data (the API server echoes it back — no different from `.status.*`); (2) direct
 * mode's live-status re-execution has no live-data source keyed by schema paths, so the field
 * could never resolve post-deploy either.
 *
 * THE FIX must be precise, not a blanket "always force a ref for metadata like status": metadata
 * is FREQUENTLY already concrete at construction time (e.g. a resource built with a literal
 * name), and other code legitimately reads that concrete value synchronously while building
 * ANOTHER resource (Ory's platform composition reads a sibling Secret's `metadata.name` this way
 * — see `test/factories/ory/platform-composition.test.ts`). So: redirect to a resource-anchored
 * ref ONLY when the underlying metadata value is ITSELF still unresolved (a KubernetesRef or
 * CelExpression); pass concrete values straight through, unchanged.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { simple } from '../../src/factories/simple/index.js';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';

describe('Resource metadata refs in status builders', () => {
  it('a status field built from a schema-ref-backed metadata.name reaches KRO status as a resource-anchored ref', () => {
    const comp = kubernetesComposition(
      {
        name: 'metadata-ref-test',
        apiVersion: 'example.com/v1',
        kind: 'MetadataRefTest',
        spec: type({ name: 'string' }),
        status: type({ host: 'string' }),
      },
      (spec) => {
        const dep = simple.Deployment({ name: spec.name, image: 'nginx', id: 'dep' });
        return {
          host: `svc-${dep.metadata.name}.default.svc.cluster.local`,
        };
      }
    );

    const yaml = comp.toYaml();

    // Resource-anchored — reaches the live KRO CR status.
    expect(yaml).toContain('host: svc-${string(dep.metadata.name)}.default.svc.cluster.local');
    // Must NOT have silently degraded to the schema ref (the exact regression).
    expect(yaml).not.toContain('schema.spec.name}.default');
    // No leaked internal markers.
    expect(yaml).not.toMatch(/__KUBERNETES_REF_|__typekroSchemaKey/);
  });

  it('a concrete metadata.name (no ref involved) still passes through unchanged when read to build a SIBLING resource — no false-positive ref generation', () => {
    // The real-world case this guards (matches Ory's platform composition: a Secret's concrete
    // name, read while building ANOTHER resource's Helm values, must stay concrete — NOT get
    // redirected to a resource-anchored ref just because access happens inside the same
    // composition function). Plain property read (not a templated status field, which hits an
    // unrelated, pre-existing status-AST-classifier limitation for template-literal-wrapped
    // resource-field reads — orthogonal to this fix).
    const comp = kubernetesComposition(
      {
        name: 'concrete-metadata-test',
        apiVersion: 'example.com/v1',
        kind: 'ConcreteMetadataTest',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (_spec) => {
        // A resource with a LITERAL (non-ref) name — the common "sibling resource reads a
        // concrete name at construction time" pattern.
        const secret = simple.Deployment({ name: 'literal-secret-name', image: 'nginx', id: 'secret' });
        // Read the sibling's concrete metadata.name to build ANOTHER resource — must be the
        // literal string itself, not a resource-anchored ref (which direct-mode value
        // resolution could never resolve for a build-time field like this).
        const referencedName = secret.metadata.name as unknown as string;
        const app = simple.Deployment({
          name: 'app',
          image: 'nginx',
          id: 'app',
          env: { SECRET_NAME: referencedName },
        });
        return {
          ready: app.status.readyReplicas !== undefined,
        };
      }
    );

    const yaml = comp.toYaml();

    // Concrete value passed straight through as a literal — no ref, no marker.
    expect(yaml).toContain('SECRET_NAME');
    expect(yaml).toContain('value: literal-secret-name');
    expect(yaml).not.toMatch(/__KUBERNETES_REF_|secret\.metadata\.name/);
  });

  it('metadata.namespace gets the same resource-anchored treatment as metadata.name', () => {
    const comp = kubernetesComposition(
      {
        name: 'metadata-namespace-test',
        apiVersion: 'example.com/v1',
        kind: 'MetadataNamespaceTest',
        spec: type({ name: 'string', namespace: 'string' }),
        status: type({ fqdn: 'string' }),
      },
      (spec) => {
        const dep = simple.Deployment({
          name: spec.name,
          namespace: spec.namespace,
          image: 'nginx',
          id: 'dep',
        });
        return {
          fqdn: `${dep.metadata.name}.${dep.metadata.namespace}.svc.cluster.local`,
        };
      }
    );

    const yaml = comp.toYaml();
    // The STATUS field is resource-anchored on `dep.metadata.*` (not `schema.spec.*` — the
    // regression); the resource's OWN template legitimately still sets its metadata FROM
    // schema.spec.* (that's how the name/namespace get there in the first place), so only the
    // status line is asserted here, not "schema.spec. never appears anywhere in the document".
    const statusLine = yaml.split('\n').find((line) => line.trim().startsWith('fqdn:'));
    expect(statusLine).toContain('dep.metadata.name');
    expect(statusLine).toContain('dep.metadata.namespace');
    expect(statusLine).not.toContain('schema.spec');
  });
});
