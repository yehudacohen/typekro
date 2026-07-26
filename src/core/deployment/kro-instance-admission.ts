import { TypeKroError } from '../errors.js';
import type { KubernetesResource } from '../types/kubernetes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Find desired object fields that the API server omitted from the admitted KRO instance.
 *
 * Additional/defaulted live fields and scalar normalization are intentionally ignored. This
 * diagnostic is narrowly aimed at structural-schema pruning, where a desired object key is absent
 * from the apply response because KRO had not yet regenerated the backing CRD schema.
 */
export function missingKroInstanceSpecPaths(
  desiredSpec: unknown,
  admittedSpec: unknown
): readonly string[] {
  const missing: string[] = [];

  const visit = (desired: unknown, admitted: unknown, path: string): void => {
    if (Array.isArray(desired)) {
      if (!Array.isArray(admitted)) {
        missing.push(path);
        return;
      }
      desired.forEach((item, index) => {
        if (index >= admitted.length) {
          missing.push(`${path}[${index}]`);
          return;
        }
        visit(item, admitted[index], `${path}[${index}]`);
      });
      return;
    }
    if (!isRecord(desired)) return;
    if (!isRecord(admitted)) {
      missing.push(path);
      return;
    }
    for (const key of Object.keys(desired).sort()) {
      const nextPath = childPath(path, key);
      if (!Object.hasOwn(admitted, key)) {
        missing.push(nextPath);
        continue;
      }
      visit(desired[key], admitted[key], nextPath);
    }
  };

  visit(desiredSpec, admittedSpec, '$.spec');
  return missing;
}

/**
 * Fail closed when Kubernetes admission silently prunes desired KRO instance fields.
 *
 * Only field paths are reported. Values are deliberately excluded so this remains safe for specs
 * that contain sensitive references or host-bound artifact inputs.
 */
export function assertKroInstanceSpecPreserved(
  desired: KubernetesResource,
  admitted: KubernetesResource
): void {
  // ResourceApplier sends a JSON clone to Kubernetes, so properties whose values
  // are undefined were never part of the admission request and cannot be pruned.
  const serializedDesiredSpec =
    desired.spec === undefined ? undefined : JSON.parse(JSON.stringify(desired.spec));
  const missingPaths = missingKroInstanceSpecPaths(serializedDesiredSpec, admitted.spec);
  if (missingPaths.length === 0) return;

  throw new TypeKroError(
    `Kubernetes admission dropped ${missingPaths.length} desired field(s) from ` +
      `${desired.kind}/${desired.metadata?.name ?? '<unknown>'}: ${missingPaths.join(', ')}. ` +
      'The generated KRO CRD schema may still be reconciling; retry after the ResourceGraphDefinition reaches its current observed generation.',
    'KRO_INSTANCE_SPEC_PRUNED',
    {
      apiVersion: desired.apiVersion,
      kind: desired.kind,
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      missingPaths,
    }
  );
}
