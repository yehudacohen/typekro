/**
 * AWS Load Balancer Controller annotations for an NLB in front of Traefik.
 */
// The NLB is a TCP passthrough: it forwards 80 and 443 to Traefik untouched and
// Traefik terminates TLS with certificates from cert-manager. That is why this
// helper has no certificate, SSL-port or backend-protocol inputs. An NLB TLS
// listener would terminate TLS before Traefik and hide SNI, ALPN and the client
// certificate from it.
//
// PROXY protocol v2 is how the client address survives the hop. With IP targets
// the NLB connects to the pod from its own private address, so without the
// header every request appears to come from the NLB. The matching Traefik side
// is `entrypoints.<name>.proxyProtocol.trustedIPs` on the bootstrap spec, set to
// the NLB's subnet CIDRs, which is where it connects from. Not the VPC CIDR:
// with the VPC CNI every pod has a VPC address, so any pod could then send a
// forged PROXY header or `X-Forwarded-For`.
//
// Annotation names are those of AWS Load Balancer Controller v2
// (https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/).

import { TypeKroError } from '../../../core/errors.js';

const PREFIX = 'service.beta.kubernetes.io/aws-load-balancer-';

/** NLB health check settings. */
export interface AwsNlbHealthCheckOptions {
  readonly protocol?: 'TCP' | 'HTTP' | 'HTTPS';
  /** A port number, or `'traffic-port'`. */
  readonly port?: number | 'traffic-port';
  /** HTTP(S) only, e.g. `'/ping'`. */
  readonly path?: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly healthyThreshold?: number;
  readonly unhealthyThreshold?: number;
}

/** Options for {@link awsNlbServiceAnnotations}. */
export interface AwsNlbServiceAnnotationOptions {
  /** Whether the NLB gets public addresses. */
  readonly scheme: 'internet-facing' | 'internal';
  /** `ip` registers pod IPs directly. @default 'ip' */
  readonly targetType?: 'ip' | 'instance';
  /** Send PROXY protocol v2 to every target port. @default true */
  readonly proxyProtocol?: boolean;
  /** Spread connections across all zones' targets. Omit to keep the AWS default. */
  readonly crossZone?: boolean;
  /** Extra load-balancer attributes, e.g. `{ 'deletion_protection.enabled': 'true' }`. */
  readonly loadBalancerAttributes?: Readonly<Record<string, string>>;
  /** Target-group attributes, e.g. `{ 'deregistration_delay.timeout_seconds': '30' }`. */
  readonly targetGroupAttributes?: Readonly<Record<string, string>>;
  readonly ipAddressType?: 'ipv4' | 'dualstack';
  /** Subnet IDs or `Name` tags. Omit to let the controller discover them. */
  readonly subnets?: readonly string[];
  /** NLB name, at most 32 characters. */
  readonly name?: string;
  readonly additionalResourceTags?: Readonly<Record<string, string>>;
  readonly healthCheck?: AwsNlbHealthCheckOptions;
}

/**
 * Service annotations for an AWS NLB that passes TCP 80/443 straight to Traefik.
 *
 * Pair it with `service.loadBalancerClass: 'service.k8s.aws/nlb'` and, when
 * `proxyProtocol` is on, `entrypoints.*.proxyProtocol.trustedIPs`.
 *
 * @throws {TypeKroError} `TRAEFIK_AWS_NLB_INVALID_OPTIONS` on conflicting or malformed options.
 * @example
 * ```typescript
 * service: {
 *   type: 'LoadBalancer',
 *   loadBalancerClass: 'service.k8s.aws/nlb',
 *   annotations: awsNlbServiceAnnotations({ scheme: 'internet-facing', crossZone: true }),
 * },
 * ```
 */
export function awsNlbServiceAnnotations(
  options: AwsNlbServiceAnnotationOptions
): Record<string, string> {
  const issues: string[] = [];
  const proxyProtocol = options.proxyProtocol ?? true;

  // The controller derives `proxy_protocol_v2.enabled` from the proxy-protocol
  // annotation, and this helper derives `load_balancing.cross_zone.enabled`
  // from `crossZone`. Setting either attribute directly as well gives two
  // sources for one setting: the controller does not reject it, one of the
  // two silently wins, and which one is not obvious from the manifest. So the
  // helper refuses the combination instead.
  if (
    options.targetGroupAttributes &&
    'proxy_protocol_v2.enabled' in options.targetGroupAttributes
  ) {
    issues.push(
      'set PROXY protocol with `proxyProtocol`, not the proxy_protocol_v2.enabled attribute.'
    );
  }
  if (
    options.crossZone !== undefined &&
    options.loadBalancerAttributes &&
    'load_balancing.cross_zone.enabled' in options.loadBalancerAttributes
  ) {
    issues.push('set cross-zone balancing with `crossZone` or the attribute, not both.');
  }
  if (options.name !== undefined && (options.name.length === 0 || options.name.length > 32)) {
    issues.push('`name` must be 1 to 32 characters.');
  }
  const lbAttributes = {
    ...(options.crossZone !== undefined && {
      'load_balancing.cross_zone.enabled': String(options.crossZone),
    }),
    ...options.loadBalancerAttributes,
  };
  const pairs = (field: string, map: Readonly<Record<string, string>>) =>
    Object.entries(map).map(([key, value]) => {
      // The controller splits these annotations on `,` and `=`.
      if (/[,=]/.test(key) || /,/.test(value)) {
        issues.push(`${field} entry ${key} must not contain "," (or "=" in the key).`);
      }
      return `${key}=${value}`;
    });

  const annotations: Record<string, string> = {
    // Ignored by the controller when `loadBalancerClass` is set; it keeps a
    // legacy in-tree cloud provider from also claiming the Service.
    [`${PREFIX}type`]: 'external',
    [`${PREFIX}scheme`]: options.scheme,
    [`${PREFIX}nlb-target-type`]: options.targetType ?? 'ip',
  };
  if (proxyProtocol) annotations[`${PREFIX}proxy-protocol`] = '*';
  if (Object.keys(lbAttributes).length > 0) {
    annotations[`${PREFIX}attributes`] = pairs('loadBalancerAttributes', lbAttributes).join(',');
  }
  if (options.targetGroupAttributes && Object.keys(options.targetGroupAttributes).length > 0) {
    annotations[`${PREFIX}target-group-attributes`] = pairs(
      'targetGroupAttributes',
      options.targetGroupAttributes
    ).join(',');
  }
  if (options.ipAddressType) annotations[`${PREFIX}ip-address-type`] = options.ipAddressType;
  if (options.subnets && options.subnets.length > 0) {
    annotations[`${PREFIX}subnets`] = options.subnets.join(',');
  }
  if (options.name !== undefined) annotations[`${PREFIX}name`] = options.name;
  if (options.additionalResourceTags && Object.keys(options.additionalResourceTags).length > 0) {
    annotations[`${PREFIX}additional-resource-tags`] = pairs(
      'additionalResourceTags',
      options.additionalResourceTags
    ).join(',');
  }
  const health = options.healthCheck;
  if (health) {
    if (health.path !== undefined && (health.protocol ?? 'TCP') === 'TCP') {
      issues.push('a health-check `path` needs protocol HTTP or HTTPS.');
    }
    const healthFields: [string, string | number | undefined][] = [
      ['healthcheck-protocol', health.protocol],
      ['healthcheck-port', health.port],
      ['healthcheck-path', health.path],
      ['healthcheck-interval', health.intervalSeconds],
      ['healthcheck-timeout', health.timeoutSeconds],
      ['healthcheck-healthy-threshold', health.healthyThreshold],
      ['healthcheck-unhealthy-threshold', health.unhealthyThreshold],
    ];
    for (const [suffix, value] of healthFields) {
      if (value !== undefined) annotations[`${PREFIX}${suffix}`] = String(value);
    }
  }

  if (issues.length > 0) {
    throw new TypeKroError(
      `Invalid AWS NLB annotation options: ${issues.join(' ')}`,
      'TRAEFIK_AWS_NLB_INVALID_OPTIONS',
      { issues }
    );
  }
  return annotations;
}
