import type { PlanValue } from '../planning/types.js';

type LiteralValue = string | number | boolean | null;

export function readinessLiteral(value: LiteralValue): PlanValue {
  return { kind: 'literal', value };
}

export function readinessConfiguration(
  entries: Readonly<Record<string, PlanValue | undefined>>
): PlanValue {
  return {
    kind: 'object',
    entries: Object.entries(entries)
      .filter((entry): entry is [string, PlanValue] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

function configurationEntries(
  configuration: PlanValue | undefined
): ReadonlyMap<string, PlanValue> {
  if (configuration?.kind !== 'object') return new Map();
  return new Map(configuration.entries.map((entry) => [entry.key, entry.value]));
}

export function optionalReadinessString(
  configuration: PlanValue | undefined,
  key: string
): string | undefined {
  const value = configurationEntries(configuration).get(key);
  return value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
}

export function requiredReadinessString(
  configuration: PlanValue | undefined,
  key: string
): string {
  const value = optionalReadinessString(configuration, key);
  if (value === undefined) {
    throw new Error(`Portable readiness configuration requires string field ${key}.`);
  }
  return value;
}

export function optionalReadinessNumber(
  configuration: PlanValue | undefined,
  key: string
): number | undefined {
  const value = configurationEntries(configuration).get(key);
  return value?.kind === 'literal' && typeof value.value === 'number' ? value.value : undefined;
}

export function optionalReadinessBoolean(
  configuration: PlanValue | undefined,
  key: string
): boolean | undefined {
  const value = configurationEntries(configuration).get(key);
  return value?.kind === 'literal' && typeof value.value === 'boolean' ? value.value : undefined;
}

export function requiredReadinessNumber(configuration: PlanValue | undefined, key: string): number {
  const value = configurationEntries(configuration).get(key);
  if (value?.kind !== 'literal' || typeof value.value !== 'number') {
    throw new Error(`Portable readiness configuration requires number field ${key}.`);
  }
  return value.value;
}

export function requiredReadinessBoolean(
  configuration: PlanValue | undefined,
  key: string
): boolean {
  const value = configurationEntries(configuration).get(key);
  if (value?.kind !== 'literal' || typeof value.value !== 'boolean') {
    throw new Error(`Portable readiness configuration requires boolean field ${key}.`);
  }
  return value.value;
}
