// Pinned AMI aliases for EC2NodeClass `amiSelectorTerms`, declared once and enforced in both
// deployment modes: the spot pool's spec schema carries the pattern, so the API server refuses
// an unpinned alias on a KRO instance, and the composition body refuses it in direct mode.

import { type } from 'arktype';
import { specConstraint } from '../../../core/validation/spec-constraint.js';

/**
 * A pinned AMI alias, `<family>@v<version>` such as `al2023@v20251117`. It refuses `@latest` and
 * a second `@`, which Karpenter v1.15.2 accepts and then crash-loops on
 * (aws/karpenter-provider-aws#9800).
 */
export const PINNED_AMI_ALIAS = /^[a-z0-9]+@v[0-9][0-9A-Za-z._-]*$/;

/** `amiAlias` of the spot pool: the pattern on the instance schema plus the direct-mode check. */
export const PINNED_AMI_ALIAS_CONSTRAINT = specConstraint({
  path: 'amiAlias',
  type: type(PINNED_AMI_ALIAS).configure({
    expected: 'a pinned AMI alias like "al2023@v20251117"',
  }),
  code: 'KARPENTER_AMI_ALIAS_NOT_PINNED',
  message: (alias) => `amiAlias must be pinned, like "al2023@v20251117"; got "${String(alias)}".`,
});

/** True when `alias` is a concrete, pinned AMI alias. */
export function isPinnedAmiAlias(alias: unknown): boolean {
  return typeof alias === 'string' && PINNED_AMI_ALIAS_CONSTRAINT.admits(alias);
}

/**
 * Throws unless `alias` is pinned. A graph reference passes here; in KRO mode the instance
 * schema's pattern refuses an unpinned alias at admission.
 */
export function assertPinnedAmiAlias(alias: unknown): void {
  PINNED_AMI_ALIAS_CONSTRAINT.check(alias);
}
