/**
 * Shared guard: no two compositions may DECLARE the same Kubernetes object.
 *
 * KRO gives every instance its own ApplySet and refuses to adopt an object
 * another ApplySet already owns:
 *
 *   resource belongs to a different ApplySet: <ns>/<name> (ConfigMap)
 *   belongs to ApplySet "<A>", cannot reassign to "<B>"
 *
 * The failure needs no drift, no race and no second apply — it happens on the
 * FIRST deploy of the second instance, and only when both compositions land in
 * one namespace under one shared release name, which is exactly how a stack is
 * normally named. Unit tests that render a single composition can never see
 * it, so this helper renders SEVERAL of them against the same name and
 * namespace and asserts their declared `(kind, namespace, name)` triples are
 * disjoint.
 *
 * Two compositions may of course both CONSUME an object; what they may not do
 * is both declare it. A composition that needs another's object takes it as an
 * input or reads it through an external reference instead.
 */

import { loadAll } from 'js-yaml';

/** One rendered composition: a label plus its materialized YAML. */
export interface RenderedComposition {
  /** Human-readable source name, used in the failure message. */
  source: string;
  /**
   * Multi-document YAML of the CONCRETE resources the composition declares —
   * `composition.factory('direct', { namespace }).toYaml(spec)`. Direct mode
   * (not `toYaml()` on the RGD) is what makes the names concrete, so two
   * renders are comparable.
   */
  yaml: string;
}

/** A single declared object, attributed to the composition that declared it. */
export interface DeclaredObject {
  source: string;
  kind: string;
  /** Empty string for cluster-scoped objects. */
  namespace: string;
  name: string;
}

/** An object declared by more than one composition. */
export interface DuplicateDeclaration {
  kind: string;
  namespace: string;
  name: string;
  /** Every composition that declared it, in render order. */
  sources: string[];
}

interface ManifestDocument {
  kind?: unknown;
  metadata?: { name?: unknown; namespace?: unknown };
}

/** Parse one rendered composition into its declared objects. */
export function collectDeclaredObjects(rendered: RenderedComposition): DeclaredObject[] {
  const documents = loadAll(rendered.yaml) as unknown[];
  const declared: DeclaredObject[] = [];

  for (const document of documents) {
    if (document === null || typeof document !== 'object') continue;
    const manifest = document as ManifestDocument;
    const kind = manifest.kind;
    const name = manifest.metadata?.name;
    // A document with no kind/name is not an object declaration (an empty
    // trailing document, or a values blob rendered alongside the manifests).
    if (typeof kind !== 'string' || typeof name !== 'string') continue;
    const namespace = manifest.metadata?.namespace;
    declared.push({
      source: rendered.source,
      kind,
      namespace: typeof namespace === 'string' ? namespace : '',
      name,
    });
  }

  return declared;
}

/**
 * Find every `(kind, namespace, name)` declared by more than one composition.
 *
 * Repeats WITHIN one composition are ignored: a single composition is one
 * ApplySet, so it cannot conflict with itself, and a duplicate there is a
 * different (KRO-level) error.
 */
export function findDuplicateDeclarations(
  renders: readonly RenderedComposition[]
): DuplicateDeclaration[] {
  // Keyed by a JSON tuple so no separator character can ever appear inside a
  // kind, a namespace or a name; the parts are carried alongside rather than
  // parsed back out of the key.
  const byObject = new Map<string, { object: DeclaredObject; sources: Set<string> }>();

  for (const rendered of renders) {
    for (const declared of collectDeclaredObjects(rendered)) {
      const key = JSON.stringify([declared.kind, declared.namespace, declared.name]);
      const entry = byObject.get(key) ?? { object: declared, sources: new Set<string>() };
      entry.sources.add(declared.source);
      byObject.set(key, entry);
    }
  }

  const duplicates: DuplicateDeclaration[] = [];
  for (const { object, sources } of byObject.values()) {
    if (sources.size < 2) continue;
    duplicates.push({
      kind: object.kind,
      namespace: object.namespace,
      name: object.name,
      sources: [...sources],
    });
  }

  return duplicates.sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
}

/**
 * Assert that no object is declared by two of the rendered compositions.
 *
 * @throws Error naming every offending object and its declarers, in the shape
 *   of the KRO ApplySet rejection the check exists to prevent
 */
export function assertNoDuplicateDeclarations(renders: readonly RenderedComposition[]): void {
  const duplicates = findDuplicateDeclarations(renders);
  if (duplicates.length === 0) return;

  const details = duplicates
    .map(
      (duplicate) =>
        `  ${duplicate.namespace || '<cluster>'}/${duplicate.name} (${duplicate.kind}) ` +
        `declared by: ${duplicate.sources.join(', ')}`
    )
    .join('\n');

  throw new Error(
    `${duplicates.length} object(s) are declared by more than one composition. KRO gives each ` +
      `instance its own ApplySet and refuses the second one ("resource belongs to a different ` +
      `ApplySet … cannot reassign"), so exactly one composition may declare each object — the ` +
      `others must take it as an input or read it through an external reference:\n${details}`
  );
}
