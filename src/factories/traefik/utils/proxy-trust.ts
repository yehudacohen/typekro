/**
 * Which upstream sources a Traefik entrypoint believes.
 */
// Traefik trusts two things from an upstream: a PROXY protocol header
// (`entryPoints.<name>.proxyProtocol`) and `X-Forwarded-*` headers
// (`entryPoints.<name>.forwardedHeaders`). Both are scoped by `trustedIPs`, and
// both have an `insecure` switch that trusts every source.
//
// Behind a load balancer the client address Traefik logs, rate-limits on and
// passes upstream comes from whichever of these it trusts. A range with a `/0`
// prefix (`0.0.0.0/0`, `::/0`) or `insecure: true` lets ANY client that reaches
// the entrypoint write that address itself: send a forged PROXY header or
// `X-Forwarded-For`, and the edge believes it. So both are refused unless the
// caller opts in with the clearly named `dangerouslyTrustAnySource`.
//
// The check has two halves because the values may not be concrete:
// - Direct mode runs the composition with concrete values, so
//   `assertTraefikProxyTrust` inspects the final chart values in JavaScript.
// - KRO mode sees schema references there, which carry no value to inspect.
//   `traefikProxyTrustSchemaFieldValidations` turns the same rule into
//   `x-kubernetes-validations` on the generated CRD, so the API server refuses
//   an instance that asks for it.
// Raw `values` and `additionalArguments` are build-time and concrete in both
// modes, so the `insecure` half is always checked in JavaScript.
//
// Environment variables are a third route (`TRAEFIK_ENTRYPOINTS_<NAME>_...`).
// Traefik reads them only when it has no CLI flags, and the chart always passes
// flags, so today they are inert. The guard does not rely on that. It refuses
// what it can see (a literal `insecure` or `/0` value) and also what it cannot:
// a non-empty `envFrom`, which can load any variable from a Secret or
// ConfigMap, and a trust variable whose value comes from `valueFrom` or a
// schema reference. The chart reads `env` and `envFrom` only at the top level
// of its values, for the Traefik container.
//
// A static configuration file is a fourth route, and it outranks the flags:
// when Traefik finds one it loads the file and ignores every flag
// (`pkg/cli/loader_file.go`). It looks at `--configFile`, then
// `/etc/traefik/traefik`, `$XDG_CONFIG_HOME/traefik`, `$HOME/.config/traefik`
// and `./traefik`, each with `.toml`, `.yaml` or `.yml`. The official image has
// no WORKDIR and the pinned UID 65532 has no passwd entry, so the working
// directory and HOME are `/` and XDG_CONFIG_HOME is unset (it expands to an
// empty string). The guard refuses `--configFile` and any raw-values mount at,
// or above, one of those files, since it cannot see what the file says.
//
// Raw `values` are trusted input. The guard catches misconfiguration, not
// deliberate YAML injection through raw values.

import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import { KUBERNETES_REF_MARKER_SOURCE } from '../../../shared/brands.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { TraefikHelmValues } from '../types.js';
import {
  parseTraefikTrustedRange,
  TRAEFIK_TRUSTED_RANGE_MAX_LENGTH,
  traefikEffectiveTrustedPrefix,
  traefikTrustedRangeCel,
} from './trusted-range.js';

/**
 * Admission rule on each KRO-mode `trustedIPs` list.
 *
 * Only the cheap part of the strict format: the API server estimates a CEL
 * rule's cost from the schema, and `matches()` over list items whose length it
 * cannot bound exceeds the CRD budget. The full format is applied when the
 * values are rendered instead (see `traefikStrictTrustedIPs`), so an entry
 * that passes here but not there is dropped before Traefik sees it.
 */
export const TRAEFIK_TRUSTED_IPS_VALIDATION_RULE =
  `self.all(range, range.size() <= ${TRAEFIK_TRUSTED_RANGE_MAX_LENGTH}` +
  " && !range.endsWith('/0') && !range.endsWith('/00')" +
  " && !range.startsWith(' ') && !range.endsWith(' ')" +
  " && !range.startsWith(',') && !range.endsWith(',')" +
  " && !range.startsWith('::ffff:') && !range.startsWith('::FFFF:'))";

// Runtime spec paths that carry a `trustedIPs` list, for the KRO-mode rule.
const TRUSTED_IP_SPEC_PATHS = [
  'entrypoints.web.proxyProtocol.trustedIPs',
  'entrypoints.web.forwardedHeaders.trustedIPs',
  'entrypoints.websecure.proxyProtocol.trustedIPs',
  'entrypoints.websecure.forwardedHeaders.trustedIPs',
] as const;

// `--entryPoints.<name>.proxyProtocol.insecure` and the forwardedHeaders twin,
// bare or with any value Go's `strconv.ParseBool` reads as true. Traefik's
// flag parser is case-insensitive.
const INSECURE_ARGUMENT = /\.(proxyprotocol|forwardedheaders)\.insecure(=(1|t|true))?$/i;
// `--entryPoints.<name>.proxyProtocol.trustedIPs=<ranges>` and the
// forwardedHeaders twin, with the value after `=` or in the next argument.
const TRUSTED_IPS_ARGUMENT =
  /\.(proxyprotocol|forwardedheaders)\.trustedips(?:\[\d+\])?(?:=(.*))?$/i;
// Any flag under an entrypoint's proxyProtocol or forwardedHeaders.
const TRUST_ARGUMENT = /\.(proxyprotocol|forwardedheaders)\./i;
// The same settings through Traefik's environment-variable configuration.
// Traefik matches variable names case-insensitively.
const INSECURE_ENV = /^TRAEFIK_ENTRYPOINTS_.+_(PROXYPROTOCOL|FORWARDEDHEADERS)_INSECURE$/i;
const TRUSTED_IPS_ENV =
  /^TRAEFIK_ENTRYPOINTS_.+_(PROXYPROTOCOL|FORWARDEDHEADERS)_TRUSTEDIPS(_[0-9]+)?$/i;
// Any variable under an entrypoint's proxyProtocol or forwardedHeaders: the
// names whose value must be visible for the guard to vouch for it.
const TRUST_ENV = /^TRAEFIK_ENTRYPOINTS_.+_(PROXYPROTOCOL|FORWARDEDHEADERS)_/i;
const TRUE_VALUE = /^(1|t|true)$/i;

// `--configFile` / `-configfile`, with the value after `=` or in the next argument.
const CONFIG_FILE_ARGUMENT = /^--?configfile(=|$)/i;
const CONFIG_FILE_EXTENSIONS = ['toml', 'yaml', 'yml'] as const;
const CONFIG_FILE_FIX =
  'Traefik would load its static configuration from that file in place of its flags, and ' +
  'TypeKro cannot see what the file says. Mount files elsewhere.';

const HIDDEN_VALUE_FIX =
  'TypeKro cannot see that value, so it cannot rule out trusting every source.';

/**
 * The problem with one `trustedIPs` entry, or `undefined` when it is a valid,
 * non-`/0` range. `where` names the setting in the message.
 */
function rangeIssue(where: string, range: string): string | undefined {
  const parsed = parseTraefikTrustedRange(range);
  if (parsed && parsed.prefix > 0) return undefined;
  // Name trust-all first: `/00`, an IPv4-mapped `/96` and a `/0` hidden in a
  // comma-joined entry all end up trusting every source.
  const trustsAll = range
    .split(',')
    .some((piece) => traefikEffectiveTrustedPrefix(piece)?.prefix === 0);
  if (parsed || trustsAll)
    return `${where} contains ${JSON.stringify(range)}, which trusts every source.`;
  return (
    `${where} contains ${JSON.stringify(range)}, which is not one IP address or CIDR range ` +
    'in the strict format: no spaces, commas, leading zeros or IPv4-mapped addresses, and a ' +
    'prefix of at most 32 (IPv4) or 128 (IPv6).'
  );
}

/** Issues for a comma-separated list of ranges, as env values and flags carry them. */
function rangeListIssues(where: string, list: string): string[] {
  if (list.includes('$(')) {
    return [`${where} uses a $(VAR) reference, which Kubernetes expands. ${HIDDEN_VALUE_FIX}`];
  }
  // Traefik splits the list on "," and trims each item.
  return list
    .split(',')
    .map((piece) => rangeIssue(where, piece.trim()))
    .filter((issue): issue is string => issue !== undefined);
}

function isConcrete(value: unknown): boolean {
  return !isKubernetesRef(value) && !isCelExpression(value);
}

const REF_MARKER = new RegExp(KUBERNETES_REF_MARKER_SOURCE);

/** A plain string, not one carrying a serialized reference marker. */
function isLiteralString(value: unknown): value is string {
  return typeof value === 'string' && !REF_MARKER.test(value);
}

/**
 * Problems with the proxy trust in final chart values; empty when there are none.
 *
 * Schema references under `ports` are skipped: KRO mode checks those on the
 * CRD. In `env` and `envFrom` nothing on the CRD checks them, so a value the
 * guard cannot see counts as a problem.
 */
export function traefikProxyTrustIssues(values: TraefikHelmValues): string[] {
  const issues: string[] = [];
  const ports = values.ports;
  if (ports && isConcrete(ports)) {
    for (const [name, port] of Object.entries(ports)) {
      if (!port || !isConcrete(port)) continue;
      for (const field of ['proxyProtocol', 'forwardedHeaders'] as const) {
        const trust = port[field];
        if (!trust || !isConcrete(trust)) continue;
        if (trust.insecure === true) {
          issues.push(`ports.${name}.${field}.insecure trusts every source.`);
        }
        const ranges = trust.trustedIPs;
        if (!Array.isArray(ranges) || !isConcrete(ranges)) continue;
        // Each entry must be one range on its own: the chart joins the list
        // with ",", so an entry carrying a comma would add ranges unseen.
        for (const range of ranges) {
          if (typeof range !== 'string') continue;
          const issue = rangeIssue(`ports.${name}.${field}.trustedIPs`, range);
          if (issue) issues.push(issue);
        }
      }
    }
  }
  issues.push(...envIssues(values));
  issues.push(...argumentIssues(values.additionalArguments));
  issues.push(...staticConfigIssues(values));
  return issues;
}

/** Proxy-trust problems in `additionalArguments`. */
function argumentIssues(args: unknown): string[] {
  const issues: string[] = [];
  if (args === undefined || args === null) return issues;
  if (!Array.isArray(args) || !isConcrete(args)) {
    issues.push(`additionalArguments is not a literal list. ${HIDDEN_VALUE_FIX}`);
    return issues;
  }
  args.forEach((arg: unknown, index) => {
    if (!isConcrete(arg) || (typeof arg === 'string' && !isLiteralString(arg))) {
      issues.push(`additionalArguments[${index}] is not a literal string. ${HIDDEN_VALUE_FIX}`);
      return;
    }
    if (typeof arg !== 'string') return;
    // Kubernetes expands $(VAR) in container arguments, so an argument that
    // uses one could become any flag or value.
    const [flag = ''] = arg.split('=');
    if (!flag.startsWith('-') || flag.includes('$(')) {
      if (arg.includes('$(')) {
        issues.push(
          `additionalArguments[${index}] uses a $(VAR) reference, which Kubernetes expands. ${HIDDEN_VALUE_FIX}`
        );
      }
      return;
    }
    if (TRUST_ARGUMENT.test(flag) && arg.includes('$(')) {
      issues.push(
        `additionalArguments sets ${flag} from a $(VAR) reference, which Kubernetes expands. ${HIDDEN_VALUE_FIX}`
      );
      return;
    }
    if (INSECURE_ARGUMENT.test(arg)) {
      issues.push(`additionalArguments contains ${arg}, which trusts every source.`);
      return;
    }
    if (CONFIG_FILE_ARGUMENT.test(arg)) {
      issues.push(`additionalArguments contains ${arg.split('=')[0]}. ${CONFIG_FILE_FIX}`);
      return;
    }
    const match = TRUSTED_IPS_ARGUMENT.exec(arg);
    if (!match) return;
    const next: unknown = args[index + 1];
    const ranges = match[2] ?? (typeof next === 'string' ? next : '');
    issues.push(...rangeListIssues(`additionalArguments ${flag}`, ranges));
  });
  return issues;
}

/** An absolute path with `.`, `..` and repeated slashes resolved; relative paths start at `/`. */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.trim().split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Whether a mount at `mountPath` would cover `file`: the same path or a parent of it. */
function covers(mountPath: string, file: string): boolean {
  return file === mountPath || file.startsWith(mountPath === '/' ? '/' : `${mountPath}/`);
}

/**
 * The files Traefik would read its static configuration from, given the
 * container's HOME and XDG_CONFIG_HOME (see the module comment for the defaults).
 */
function staticConfigFiles(home: string, xdgConfigHome: string): string[] {
  const bases = [
    '/etc/traefik/traefik',
    `${xdgConfigHome}/traefik`,
    `${home}/.config/traefik`,
    '/traefik',
  ];
  return bases.flatMap((base) =>
    CONFIG_FILE_EXTENSIONS.map((extension) => normalizePath(`${base}.${extension}`))
  );
}

/** Static-configuration-file problems: raw mounts over the files Traefik searches. */
function staticConfigIssues(values: TraefikHelmValues): string[] {
  const issues: string[] = [];
  // A literal HOME or XDG_CONFIG_HOME moves the search; one from a reference
  // hides it. A non-literal `env` list is already reported by `envIssues`.
  const location = { HOME: '/', XDG_CONFIG_HOME: '' };
  const env: unknown = values.env;
  if (Array.isArray(env) && isConcrete(env)) {
    for (const entry of env) {
      if (!isLiteralRecord(entry)) continue;
      const name = entry.name;
      if (name !== 'HOME' && name !== 'XDG_CONFIG_HOME') continue;
      // Kubernetes expands $(VAR) in env values, so one would hide the path.
      if (
        isLiteralString(entry.value) &&
        entry.valueFrom === undefined &&
        !entry.value.includes('$(')
      ) {
        location[name] = entry.value;
      } else {
        issues.push(
          `env ${name} takes its value from a reference or a $(VAR) expansion, so TypeKro ` +
            'cannot see where Traefik ' +
            'looks for a static configuration file.'
        );
      }
    }
  }
  const files = staticConfigFiles(location.HOME, location.XDG_CONFIG_HOME);

  const checkPath = (where: string, path: unknown): void => {
    if (path === undefined || path === null) return;
    // The chart runs `additionalVolumeMounts` through `tpl`, so `{{ }}` is
    // evaluated at render time.
    if (!isLiteralString(path) || path.includes('{{')) {
      issues.push(`${where} is not a literal path. ${CONFIG_FILE_FIX}`);
      return;
    }
    const mountPath = normalizePath(path);
    const file = files.find((candidate) => covers(mountPath, candidate));
    if (file) issues.push(`${where} mounts ${path} over ${file}. ${CONFIG_FILE_FIX}`);
  };
  const checkList = (where: string, list: unknown): void => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list) || !isConcrete(list)) {
      issues.push(`${where} is not a literal list. ${CONFIG_FILE_FIX}`);
      return;
    }
    list.forEach((entry: unknown, index) => {
      if (entry === undefined || entry === null) return;
      checkPath(`${where}[${index}].mountPath`, isLiteralRecord(entry) ? entry.mountPath : entry);
    });
  };
  const checkSection = (where: string, section: unknown, field: string): void => {
    if (section === undefined || section === null) return;
    if (!isLiteralRecord(section)) {
      issues.push(`${where} is not a literal object. ${CONFIG_FILE_FIX}`);
      return;
    }
    checkPath(`${where}.${field}`, section[field]);
  };

  // Every raw-values mount the chart adds to the Traefik container.
  // `deployment.additionalVolumes` only declares volumes; they are mounted
  // through `additionalVolumeMounts` or a `localPath` local plugin.
  checkList('additionalVolumeMounts', values.additionalVolumeMounts);
  checkList('volumes', values.volumes);
  checkSection('persistence', values.persistence, 'path');
  checkSection('hub', values.hub, 'tokenMountPath');
  const experimental: unknown = values.experimental;
  if (experimental !== undefined && experimental !== null) {
    if (!isLiteralRecord(experimental)) {
      issues.push(`experimental is not a literal object. ${CONFIG_FILE_FIX}`);
    } else {
      const localPlugins = experimental.localPlugins;
      if (localPlugins !== undefined && localPlugins !== null && !isLiteralRecord(localPlugins)) {
        issues.push(`experimental.localPlugins is not a literal object. ${CONFIG_FILE_FIX}`);
      } else if (localPlugins) {
        for (const [name, plugin] of Object.entries(localPlugins)) {
          if (plugin === undefined || plugin === null) continue;
          checkPath(
            `experimental.localPlugins.${name}.mountPath`,
            isLiteralRecord(plugin) ? plugin.mountPath : plugin
          );
        }
      }
    }
  }
  return issues;
}

/** A concrete object, as opposed to a schema reference or CEL expression. */
function isLiteralRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isConcrete(value);
}

/** Proxy-trust problems in the Traefik container's `env` and `envFrom`. */
function envIssues(values: TraefikHelmValues): string[] {
  const issues: string[] = [];
  const envFrom: unknown = values.envFrom;
  if (
    envFrom !== undefined &&
    envFrom !== null &&
    !(Array.isArray(envFrom) && envFrom.length === 0)
  ) {
    issues.push(
      'envFrom can load TRAEFIK_ENTRYPOINTS_* variables from a Secret or ConfigMap. ' +
        `${HIDDEN_VALUE_FIX} Pass other variables as individual \`env\` entries, where \`valueFrom\` is fine.`
    );
  }
  const env: unknown = values.env;
  if (env === undefined || env === null) return issues;
  if (!Array.isArray(env) || !isConcrete(env)) {
    issues.push(
      `env is not a literal list, so its variable names are unknown. ${HIDDEN_VALUE_FIX}`
    );
    return issues;
  }
  for (const entry of env) {
    if (entry === undefined || entry === null) continue;
    const name = isLiteralRecord(entry) ? entry.name : undefined;
    if (!isLiteralRecord(entry) || typeof name !== 'string') {
      issues.push(`env has an entry whose name is not a literal string. ${HIDDEN_VALUE_FIX}`);
      continue;
    }
    if (!TRUST_ENV.test(name)) continue;
    const { value, valueFrom } = entry;
    if (valueFrom !== undefined || (value !== undefined && !isLiteralString(value))) {
      issues.push(`env ${name} takes its value from a reference. ${HIDDEN_VALUE_FIX}`);
      continue;
    }
    if (typeof value !== 'string') continue;
    if (value.includes('$(')) {
      issues.push(
        `env ${name} uses a $(VAR) reference, which Kubernetes expands. ${HIDDEN_VALUE_FIX}`
      );
    } else if (INSECURE_ENV.test(name) && TRUE_VALUE.test(value.trim())) {
      issues.push(`env ${name}=${value} trusts every source.`);
    } else if (TRUSTED_IPS_ENV.test(name)) {
      issues.push(...rangeListIssues(`env ${name}`, value));
    }
  }
  return issues;
}

/**
 * Throw when final chart values trust every source for PROXY protocol or forwarded headers,
 * or carry trust settings whose value TypeKro cannot see.
 *
 * @throws {TypeKroError} With code `TRAEFIK_UNTRUSTED_PROXY_SOURCE`.
 */
export function assertTraefikProxyTrust(values: TraefikHelmValues): void {
  const issues = traefikProxyTrustIssues(values);
  if (issues.length === 0) return;
  throw new TypeKroError(
    `Traefik could trust any client to set its own source address: ${issues.join(' ')} ` +
      'Set the trust through the typed `entrypoints.<name>.proxyProtocol` / `forwardedHeaders` ' +
      'options instead, listing the load balancer or proxy ranges (for an AWS NLB with IP ' +
      "targets, the NLB's subnet CIDRs). If trusting any source is intended, pass " +
      '`dangerouslyTrustAnySource: true` to makeTraefikBootstrap, and only for a Traefik that no ' +
      'client can reach directly.',
    'TRAEFIK_UNTRUSTED_PROXY_SOURCE',
    { issues }
  );
}

/**
 * Warnings for trusted ranges that are legal but very broad: an IPv4 prefix
 * shorter than /8 or an IPv6 prefix shorter than /16.
 */
export function traefikBroadTrustWarnings(values: TraefikHelmValues): string[] {
  const warnings: string[] = [];
  const ports = values.ports;
  if (!ports || !isConcrete(ports)) return warnings;
  for (const [name, port] of Object.entries(ports)) {
    if (!port || !isConcrete(port)) continue;
    for (const field of ['proxyProtocol', 'forwardedHeaders'] as const) {
      const ranges = port[field]?.trustedIPs;
      if (!Array.isArray(ranges) || !isConcrete(ranges)) continue;
      for (const entry of ranges) {
        if (typeof entry !== 'string') continue;
        // Read the way Go does: an IPv4-mapped `/96` is IPv4 `/0`.
        for (const range of entry.split(',')) {
          const effective = traefikEffectiveTrustedPrefix(range);
          if (!effective) continue;
          const where = `ports.${name}.${field}.trustedIPs contains ${range.trim()}`;
          if (effective.prefix === 0) {
            warnings.push(`${where}, which trusts every source.`);
          } else if (effective.prefix < (effective.family === 6 ? 16 : 8)) {
            warnings.push(
              `${where}, which trusts a very large address range. List the load balancer or proxy ranges instead.`
            );
          }
        }
      }
    }
  }
  return warnings;
}

/** `schemaFieldValidations` refusing `/0` trusted ranges on a KRO instance. */
export function traefikProxyTrustSchemaFieldValidations(): Record<string, string> {
  return Object.fromEntries(
    TRUSTED_IP_SPEC_PATHS.map((path) => [path, TRAEFIK_TRUSTED_IPS_VALIDATION_RULE])
  );
}

/**
 * A `trustedIPs` value for the chart, holding a KRO schema reference to the
 * entries that pass the strict format.
 *
 * Direct mode sees concrete lists, which the guard checks whole. In KRO mode
 * the API server can afford only the cheap admission rule, so the rendered
 * values keep just the entries that are one valid range (and, unless
 * `allowAnySource`, not `/0`). A dropped entry narrows trust; it never widens it.
 */
export function traefikStrictTrustedIPs<T>(ranges: T, allowAnySource: boolean): T {
  if (!isKubernetesRef(ranges) || ranges.resourceId !== '__schema__') return ranges;
  const path = `schema.${ranges.fieldPath}`;
  const segments = path.split('.');
  // `has()` on every optional level, as serialization does for a bare reference.
  const guards = segments
    .slice(2)
    .map((_, index) => `has(${segments.slice(0, index + 3).join('.')})`);
  return Cel.expr<T>(
    `${guards.join(' && ')} ? `,
    ranges,
    `.filter(range, ${traefikTrustedRangeCel('range', allowAnySource)}) : omit()`
  );
}
