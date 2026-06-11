/**
 * GitOps emission for singleton owners.
 *
 * `singleton(...)` deploys ONE shared owner instance (in the registry namespace,
 * named deterministically, carrying a spec-fingerprint annotation) that the
 * consuming RGD references via `externalRef`. The factory's `deploy()` path
 * creates that owner imperatively — but the GitOps `toYaml()` path emits only the
 * consuming RGD/instance, leaving the externalRef dangling. These helpers let the
 * `toYaml()` paths emit the missing owner RGD(s) and owner instance(s) so a
 * GitOps apply (Flux/ArgoCD) of the generated YAML is complete.
 *
 * The owner instance is built to match exactly what `deploy()` creates — the same
 * derived name, registry namespace, and fingerprint annotation — so the consuming
 * RGD's externalRef resolves AND a later imperative `deploy()` finds the existing
 * owner and passes its drift check instead of conflicting.
 */
import * as yaml from 'js-yaml';
import { singletonInstanceTypeMeta } from '../singleton/singleton.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from './resource-tagging.js';
import { getSingletonInstanceName } from './shared-utilities.js';
import { singletonSpecFingerprintAnnotationValue } from './singleton-owner-drift.js';

const DOC_SEPARATOR = '\n---\n';

/** One record per distinct singleton identity (a singleton may be referenced more than once). */
function dedupeByKey(
  definitions: readonly SingletonDefinitionRecord[]
): SingletonDefinitionRecord[] {
  const byKey = new Map<string, SingletonDefinitionRecord>();
  for (const definition of definitions) {
    if (!byKey.has(definition.key)) byKey.set(definition.key, definition);
  }
  return [...byKey.values()];
}

/** RGD YAML for each singleton owner composition (the CRD + resource graph it owns). */
export function singletonRgdYamls(
  definitions: readonly SingletonDefinitionRecord[]
): string[] {
  return dedupeByKey(definitions).map((definition) =>
    (definition.composition as unknown as { toYaml: () => string }).toYaml()
  );
}

/** Owner-instance manifests — one shared CR per singleton, matching `deploy()`. */
export function singletonOwnerInstanceManifests(
  definitions: readonly SingletonDefinitionRecord[]
): unknown[] {
  return dedupeByKey(definitions).map((definition) => {
    const { apiVersion, kind } = singletonInstanceTypeMeta(definition.composition);
    return {
      apiVersion,
      kind,
      metadata: {
        name: getSingletonInstanceName(definition.id),
        namespace: definition.registryNamespace,
        annotations: {
          [SINGLETON_SPEC_FINGERPRINT_ANNOTATION]: singletonSpecFingerprintAnnotationValue(
            definition.specFingerprint
          ),
        },
      },
      spec: definition.spec,
    };
  });
}

/** Owner-instance YAML documents (one per singleton). */
export function singletonOwnerInstanceYamls(
  definitions: readonly SingletonDefinitionRecord[]
): string[] {
  return singletonOwnerInstanceManifests(definitions).map((manifest) =>
    yaml.dump(manifest, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()
  );
}

/** Join YAML documents, dropping empties, with the leading docs emitted deps-first. */
export function joinYamlDocuments(leadingDocs: string[], main: string): string {
  return [...leadingDocs, main].map((doc) => doc.trim()).filter((doc) => doc.length > 0).join(
    DOC_SEPARATOR
  );
}
