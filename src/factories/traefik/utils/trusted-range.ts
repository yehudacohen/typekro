/**
 * The strict format TypeKro accepts for a Traefik `trustedIPs` entry.
 */
// Traefik parses each entry with Go's `net.ParseCIDR`, falling back to
// `net.ParseIP`. Go is more lenient than its output suggests:
// - `0.0.0.0/00` and `::/00` parse, with leading zeros, as `/0`.
// - `::ffff:0.0.0.0/96` (and `::ffff:0:0/96`) is an IPv4-mapped network. Go
//   matches IPv4 clients against its last 32 bits, so `/96` is IPv4 `/0`.
// - The chart joins a list with "," and Traefik splits and trims it again, so
//   `'0.0.0.0/0,10.0.0.0/8'` or `'0.0.0.0/0 '` in one entry still trusts all.
// So a suffix test on the text is not enough. An entry must be exactly one
// IPv4 or IPv6 address, optionally with a decimal prefix without leading
// zeros (0-32 or 0-128), with no spaces, commas, zone or embedded IPv4, and no
// IPv4-mapped address at all. A `/0` prefix passes the format; refusing it is
// the proxy-trust guard's job, which `dangerouslyTrustAnySource` turns off.
//
// The patterns use only RE2 syntax (no lookaround, no backslashes), so the same
// strings work in JavaScript, in CEL `matches()` and in a Kubernetes `pattern`.

const HEX = '[0-9a-fA-F]{1,4}';
const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4 = `${OCTET}([.]${OCTET}){3}`;
const IPV6 = [
  `(${HEX}:){7}${HEX}`,
  `(${HEX}:){1,7}:`,
  `(${HEX}:){1,6}:${HEX}`,
  `(${HEX}:){1,5}(:${HEX}){1,2}`,
  `(${HEX}:){1,4}(:${HEX}){1,3}`,
  `(${HEX}:){1,3}(:${HEX}){1,4}`,
  `(${HEX}:){1,2}(:${HEX}){1,5}`,
  `${HEX}:(:${HEX}){1,6}`,
  `:((:${HEX}){1,7}|:)`,
].join('|');
const IPV4_PREFIX = '(3[0-2]|[12][0-9]|[0-9])';
const IPV6_PREFIX = '(12[0-8]|1[01][0-9]|[1-9][0-9]|[0-9])';

/** One IPv4 or IPv6 address or CIDR range, with a prefix of 0-32 or 0-128 and no leading zeros. */
export const TRAEFIK_TRUSTED_RANGE_PATTERN = `^(${IPV4}(/${IPV4_PREFIX})?|(${IPV6})(/${IPV6_PREFIX})?)$`;
/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, `::ffff:0:0`, ...), which is refused outright. */
export const TRAEFIK_IPV4_MAPPED_PATTERN = '^[0:]*:[fF]{4}:';
/** Longest valid entry: a full IPv6 address and `/128`. */
export const TRAEFIK_TRUSTED_RANGE_MAX_LENGTH = 43;

const RANGE = new RegExp(TRAEFIK_TRUSTED_RANGE_PATTERN);
const IPV4_MAPPED = new RegExp(TRAEFIK_IPV4_MAPPED_PATTERN);

/** A trusted range in the strict format. */
export interface TraefikTrustedRange {
  readonly family: 4 | 6;
  /** The prefix length; a bare address counts as `/32` or `/128`. */
  readonly prefix: number;
}

/** Parse one `trustedIPs` entry, or `undefined` when it is not in the strict format. */
export function parseTraefikTrustedRange(value: string): TraefikTrustedRange | undefined {
  if (!RANGE.test(value) || IPV4_MAPPED.test(value)) return undefined;
  const [address = '', prefix] = value.split('/');
  const family = address.includes(':') ? 6 : 4;
  return { family, prefix: prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix) };
}

/**
 * The prefix Go would effectively apply to an entry, read leniently: leading
 * zeros allowed, and an IPv4-mapped `/n` counted as IPv4 `/(n-96)` (or `/0`
 * below 96). For warnings about entries the strict format may not cover.
 */
export function traefikEffectiveTrustedPrefix(value: string): TraefikTrustedRange | undefined {
  const match = /^([^/]*)(?:\/([0-9]+))?$/.exec(value.trim());
  if (!match) return undefined;
  const address = match[1] ?? '';
  const family = address.includes(':') ? 6 : 4;
  const full = family === 4 ? 32 : 128;
  const prefix = match[2] === undefined ? full : Number(match[2]);
  if (family === 6 && IPV4_MAPPED.test(address)) {
    return { family: 4, prefix: prefix >= 96 ? prefix - 96 : 0 };
  }
  return { family, prefix };
}

/**
 * A CEL predicate over the string variable `name` that holds when it is in the
 * strict format and, unless `allowAnySource`, is not a `/0` range.
 */
export function traefikTrustedRangeCel(name: string, allowAnySource = false): string {
  return [
    `${name}.matches('${TRAEFIK_TRUSTED_RANGE_PATTERN}')`,
    `!${name}.matches('${TRAEFIK_IPV4_MAPPED_PATTERN}')`,
    ...(allowAnySource ? [] : [`!${name}.endsWith('/0')`]),
  ].join(' && ');
}
