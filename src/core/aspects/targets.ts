import { getKindInfo } from '../resources/factory-registry.js';

function pascalCaseFactoryName(name: string): string {
  return name.length === 0 ? name : `${name[0]?.toUpperCase()}${name.slice(1)}`;
}

/**
 * Resolves a public aspect factory target to its Kubernetes kind identity.
 *
 * Aspect factory targets are intentionally kind-level, not function-instance
 * identities. This lets simple, base Kubernetes, and custom registered
 * factories that produce the same Kubernetes kind share the same aspect target.
 */
export function resolveFactoryTargetId(
  target: (...args: never[]) => unknown
): string | undefined {
  const reflectedTargetId = Reflect.get(target, '__typekroAspectTargetId');
  if (typeof reflectedTargetId === 'string' && reflectedTargetId.length > 0) {
    return reflectedTargetId;
  }

  const directRegistration = getKindInfo(target.name);
  if (directRegistration) return directRegistration.kind;

  const pascalRegistration = getKindInfo(pascalCaseFactoryName(target.name));
  return pascalRegistration?.kind;
}
