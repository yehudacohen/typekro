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

// The eight 16-bit groups of a valid IPv6 address (dotted IPv4 tail included).
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, head = '', a, b, c, d] = dotted;
    const octets = [a, b, c, d].map(Number) as [number, number, number, number];
    text = `${head}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16));
}

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), which Go treats as IPv4. */
function isIpv4Mapped(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const groups = ipv6Groups(address);
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/**
 * A range that matches every address: any `/0`, or an IPv4-mapped range with
 * at most 96 bits (`::ffff:0.0.0.0/96`). Go's `net.IPNet` matches IPv4 clients
 * against the last 32 bits of such a mask, which are then all zero.
 */
export function isAnyAddressRange(value: string): boolean {
  if (!isCidr(value)) return false;
  const [address = '', bits = ''] = value.split('/');
  return Number(bits) === 0 || (isIpv4Mapped(address) && Number(bits) <= 96);
}
