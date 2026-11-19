// Pinned AMI aliases for EC2NodeClass `amiSelectorTerms`, declared once and enforced in both
// deployment modes: a spec schema that declares the field with the constraint's type carries the
// pattern and `required=true`, so the API server refuses a missing or unpinned alias on a KRO
// instance, and the composition body refuses one in direct mode.

import { type Type, type } from 'arktype';
import { specConstraint } from '../../../core/validation/spec-constraint.js';

/**
 * A pinned AMI alias, `<family>@v<version>` such as `al2023@v20251117`. It refuses `@latest` and
 * a second `@`, which Karpenter v1.15.2 accepts and then crash-loops on
 * (aws/karpenter-provider-aws#9800).
 */
export const PINNED_AMI_ALIAS = /^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$/;

/**
 * `amiAlias` of the spot pool: the pattern and `required=true` on the instance schema, plus the
 * direct-mode check.
 */
export const PINNED_AMI_ALIAS_CONSTRAINT = specConstraint({
  path: 'amiAlias',
  type: type(PINNED_AMI_ALIAS).configure({
    expected: 'a pinned AMI alias like "al2023@v20251117"',
  }),
  required: true,
  code: 'KARPENTER_AMI_ALIAS_NOT_PINNED',
  declaredWith: 'PinnedAmiAliasSchema',
  message: (alias) => `amiAlias must be pinned, like "al2023@v20251117"; got "${String(alias)}".`,
});

/**
 * The ArkType of a pinned AMI alias. A composition that passes one of its own spec fields as the
 * alias, for example to `karpenterSpotPool` composed inside it, declares that field with this
 * type as a required key.
 */
export const PinnedAmiAliasSchema: Type<string> = PINNED_AMI_ALIAS_CONSTRAINT.type;

/** True when `alias` is a concrete, pinned AMI alias. */
export function isPinnedAmiAlias(alias: unknown): boolean {
  return typeof alias === 'string' && PINNED_AMI_ALIAS_CONSTRAINT.admits(alias);
}

/**
 * Throws unless `alias` is a concrete pinned alias or a reference to a required spec field
 * declared with {@link PinnedAmiAliasSchema}, whose instance schema refuses an unpinned
 * alias at admission. Any other reference, or a missing alias, is refused at build time.
 */
export function assertPinnedAmiAlias(alias: unknown): void {
  PINNED_AMI_ALIAS_CONSTRAINT.enforce(alias);
}
