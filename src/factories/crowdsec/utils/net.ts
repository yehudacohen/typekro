// Address and value-shape checks shared by the CrowdSec values mapper and the
// Traefik bouncer helper. Internal: not re-exported from `typekro/crowdsec`.

import { isIP } from 'node:net';

import { REQUIRED_FIELD_SENTINEL } from '../../../core/serialization/schema.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';

// What a schema proxy stringifies to inside a template literal.
const KUBERNETES_REF_MARKER_PREFIX = '__KUBERNETES_REF_';

/**
 * A value only known at reconcile time: a schema or resource reference, a CEL
 * expression, a template literal over a reference, or the placeholder the
 * defaults-extraction pass substitutes for required fields. Never validated or
 * branched on as if it were the user's value.
 */
export function isDeferredValue(value: unknown): boolean {
  return (
    isKubernetesRef(value) ||
    isCelExpression(value) ||
    (typeof value === 'string' &&
      (value.includes(KUBERNETES_REF_MARKER_PREFIX) || value.includes(REQUIRED_FIELD_SENTINEL)))
  );
}

/**
 * An IPv4 or IPv6 address as Go's `net.ParseIP` reads it: no port, no zone, no
 * leading zeros in IPv4 octets; IPv4-mapped IPv6 (`::ffff:192.0.2.1`) is fine.
 */
export function isIp(value: string): boolean {
  return !value.includes('%') && isIP(value) !== 0;
}

/** An `address/bits` range, as Go's `net.ParseCIDR` reads it. */
export function isCidr(value: string): boolean {
  const [address, bits, extra] = value.split('/');
  if (address === undefined || bits === undefined || extra !== undefined || !/^\d+$/.test(bits)) {
    return false;
  }
  return isIp(address) && Number(bits) <= (isIP(address) === 6 ? 128 : 32);
}

/** A range that matches every address: `0.0.0.0/0`, `::/0`, or any other `/0`. */
export function isAnyAddressRange(value: string): boolean {
  return isCidr(value) && /\/0+$/.test(value);
}
