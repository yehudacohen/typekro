/**
 * Traefik Helm values mapping.
 *
 * Turns the bootstrap composition's runtime spec into values for the official
 * `traefik` chart 41.5.0, then applies the security pins from #172 LAST so no
 * caller — not even the build-time `values` passthrough — can re-enable the
 * dashboard or the insecure API.
 *
 * Every value produced here may be a schema reference in KRO mode. The mapping
 * therefore never branches on a spec value; it only places values into the
 * tree. Decisions about which configuration EXISTS live in
 * {@link TraefikHelmValuesMapperOptions} and are concrete at build time.
 */

import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_INGRESS_CLASS,
  DEFAULT_TRAEFIK_WEB_PORT,
  DEFAULT_TRAEFIK_WEBSECURE_PORT,
  TRAEFIK_WEBSECURE_ENTRYPOINT,
} from '../constants.js';
import type {
  TraefikBootstrapConfig,
  TraefikHelmValues,
  TraefikPortValues,
  TraefikServiceType,
} from '../types.js';

/**
 * Pod-level security context Traefik runs with.
 *
 * @security Matches the chart's own hardened defaults and is re-pinned here so
 * a values passthrough cannot drop `runAsNonRoot`.
 */
export const TRAEFIK_POD_SECURITY_CONTEXT = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  seccompProfile: { type: 'RuntimeDefault' },
} as const;

/**
 * Container-level security context Traefik runs with.
 *
 * @security No privilege escalation, all capabilities dropped, read-only root
 * filesystem. Traefik needs no writable root; ACME storage, when used, gets an
 * explicit volume.
 */
export const TRAEFIK_CONTAINER_SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
} as const;

/**
 * Values this factory pins unconditionally, applied after every other source.
 *
 * @security The chart ships `api.dashboard: true`. An edge that exposes the
 * Traefik dashboard exposes its full routing table, and `api.insecure` serves
 * the API unauthenticated over plain HTTP on the `traefik` entrypoint. Neither
 * is switchable through this factory: the runtime spec cannot express `true`
 * (`dashboard` is typed as the literal `false`) and these pins overwrite any
 * build-time passthrough. Re-enabling them means not using this factory.
 */
export const TRAEFIK_SECURITY_PINS = {
  api: { dashboard: false, insecure: false, debug: false },
  ingressRoute: { dashboard: { enabled: false }, healthcheck: { enabled: false } },
  podSecurityContext: TRAEFIK_POD_SECURITY_CONTEXT,
  securityContext: TRAEFIK_CONTAINER_SECURITY_CONTEXT,
  global: { checkNewVersion: false, sendAnonymousUsage: false },
} as const;

/** Build-time inputs that shape which configuration the values tree contains. */
export interface TraefikHelmValuesMapperOptions {
  /**
   * Concrete chart values merged BEFORE the mapped values and the security
   * pins, both of which win. Use for chart surface this factory does not model.
   */
  readonly baseValues?: TraefikHelmValues;
  /**
   * Emit a permanent `web` → `websecure` redirect. The chart disables the
   * redirect by omitting `ports.web.http.redirections.entryPoint`, so this is
   * structural rather than a value. @default true
   */
  readonly redirectWebToWebsecure?: boolean;
  /** Namespace Traefik is installed into, used for the Gateway status address. */
  readonly targetNamespace?: string;
}

/**
 * Whether a value is a graph value — a schema/resource reference or a CEL
 * expression — rather than a concrete literal.
 *
 * The distinction matters wherever the mapper must ask a QUESTION about a
 * value instead of merely placing it: a reference has to be interrogated in
 * CEL, a literal in JavaScript.
 */
function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `override` onto `base` one level deep.
 *
 * Only top-level sections are merged; a section present in both is replaced
 * key-by-key rather than recursively, which keeps the merge from ever spreading
 * a nested schema reference.
 */
function mergeSections(base: TraefikHelmValues, override: TraefikHelmValues): TraefikHelmValues {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return merged as TraefikHelmValues;
}

/**
 * Overwrite the security-relevant values, whatever they were.
 *
 * Written as explicit spreads at known depths rather than a generic deep merge
 * so the precedence is auditable by reading it.
 */
export function applyTraefikSecurityPins(values: TraefikHelmValues): TraefikHelmValues {
  return {
    ...values,
    api: { ...values.api, ...TRAEFIK_SECURITY_PINS.api },
    ingressRoute: {
      ...values.ingressRoute,
      dashboard: { ...values.ingressRoute?.dashboard, enabled: false },
      healthcheck: { ...values.ingressRoute?.healthcheck, enabled: false },
    },
    podSecurityContext: { ...values.podSecurityContext, ...TRAEFIK_POD_SECURITY_CONTEXT },
    securityContext: { ...values.securityContext, ...TRAEFIK_CONTAINER_SECURITY_CONTEXT },
    global: { ...values.global, ...TRAEFIK_SECURITY_PINS.global },
  };
}

/**
 * Map the bootstrap runtime spec onto official-chart values.
 *
 * @param config - The bootstrap spec. Any field may be a schema reference.
 * @param options - Build-time structural choices.
 * @returns Chart values with the security pins already applied.
 *
 * @example
 * ```typescript
 * const values = mapTraefikConfigToHelmValues({
 *   name: 'traefik',
 *   namespace: 'traefik',
 *   service: { type: 'LoadBalancer', annotations: { 'service.beta.kubernetes.io/aws-load-balancer-type': 'external' } },
 *   providers: { crd: true, gatewayApi: false },
 *   accessLogs: true,
 * });
 * ```
 */
export function mapTraefikConfigToHelmValues(
  config: TraefikBootstrapConfig,
  options: TraefikHelmValuesMapperOptions = {}
): TraefikHelmValues {
  // Every spec-derived default goes through `Cel.default`, never `??`: a schema
  // proxy is a truthy object, so `??` would silently keep the reference and
  // drop the fallback in KRO mode, leaving the chart's own default in place and
  // making direct and KRO deployments disagree.
  const ingressClass = Cel.default(config.ingressClass, DEFAULT_TRAEFIK_INGRESS_CLASS);
  const serviceType: TraefikServiceType = Cel.default(config.service?.type, 'LoadBalancer');
  const redirect = options.redirectWebToWebsecure ?? true;

  // OTLP is enabled by the PRESENCE of an endpoint. In KRO mode the endpoint is
  // a schema reference, so the enablement has to be a CEL comparison — a
  // JavaScript truthiness test on a proxy is always true. With a concrete spec
  // the same question is answered in JavaScript, because CEL over a literal
  // would have to quote the value itself.
  const endpointInput = config.otlp?.endpoint;
  const otlpEndpoint = Cel.default(endpointInput, '');
  const otlpEnabled: boolean = isGraphValue(endpointInput)
    ? // Compare the GUARDED expression, not the bare reference: `schema.spec.otlp`
      // is absent whenever the block is omitted, and unguarded field selection on
      // an absent message is a CEL evaluation error rather than a false.
      Cel.expr<boolean>(otlpEndpoint, ' != ""')
    : typeof endpointInput === 'string' && endpointInput.length > 0;
  const otlpInsecure = Cel.default(config.otlp?.insecure, true);
  const otlpServiceName = Cel.default(config.otlp?.serviceName, 'traefik');

  const webPort: TraefikPortValues = {
    exposedPort: Cel.default(config.entrypoints?.web?.exposedPort, DEFAULT_TRAEFIK_WEB_PORT),
    expose: { default: Cel.default(config.entrypoints?.web?.expose, true) },
    ...(redirect
      ? {
          http: {
            redirections: {
              entryPoint: {
                to: TRAEFIK_WEBSECURE_ENTRYPOINT,
                scheme: 'https',
                permanent: true,
              },
            },
          },
        }
      : {}),
  };

  const websecurePort: TraefikPortValues = {
    exposedPort: Cel.default(
      config.entrypoints?.websecure?.exposedPort,
      DEFAULT_TRAEFIK_WEBSECURE_PORT
    ),
    expose: { default: Cel.default(config.entrypoints?.websecure?.expose, true) },
    tls: { enabled: true },
    // An edge fronting requests longer than Traefik's 60s default must raise
    // the responding timeouts here as well as the upstream ServersTransport.
    transport: {
      respondingTimeouts: {
        readTimeout: Cel.default(config.entrypoints?.websecure?.readTimeout, '90s'),
        writeTimeout: Cel.default(config.entrypoints?.websecure?.writeTimeout, '90s'),
        idleTimeout: Cel.default(config.entrypoints?.websecure?.idleTimeout, '180s'),
      },
    },
  };

  const mapped: TraefikHelmValues = {
    // Pin the resource-name anchor so the entrypoint Service is named exactly
    // `config.name`. Without it the chart's fullname template decides, and the
    // bootstrap status contract could not name the Service it observes.
    fullnameOverride: config.name,
    deployment: { replicas: Cel.default(config.replicas, 2) },
    ingressClass: {
      enabled: true,
      // Claiming the cluster-default IngressClass would silently capture every
      // class-less Ingress in the cluster. Opt in through `baseValues`.
      isDefaultClass: false,
      name: ingressClass,
    },
    providers: {
      kubernetesCRD: {
        enabled: Cel.default(config.providers?.crd, true),
        ingressClass,
      },
      kubernetesIngress: {
        enabled: Cel.default(config.providers?.kubernetesIngress, false),
      },
      kubernetesGateway: {
        enabled: Cel.default(config.providers?.gatewayApi, false),
      },
    },
    log: { level: Cel.default(config.logLevel, 'INFO'), format: 'json' },
    accessLog: {
      enabled: Cel.default(config.accessLogs, true),
      format: 'json',
      // Health and metrics traffic on the internal entrypoint would otherwise
      // dominate the access log.
      addInternals: false,
    },
    metrics: {
      otlp: {
        enabled: otlpEnabled,
        grpc: { enabled: otlpEnabled, endpoint: otlpEndpoint, insecure: otlpInsecure },
      },
    },
    tracing: {
      serviceName: otlpServiceName,
      otlp: {
        enabled: otlpEnabled,
        grpc: { enabled: otlpEnabled, endpoint: otlpEndpoint, insecure: otlpInsecure },
      },
    },
    ports: {
      web: webPort,
      websecure: websecurePort,
      // @security The internal entrypoint serves /ping, metrics and the (pinned
      // off) dashboard. It must never be published by the Service.
      traefik: { expose: { default: false } },
    },
    service: {
      enabled: true,
      spec: { type: serviceType },
      ...(config.service?.annotations ? { annotations: config.service.annotations } : {}),
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    },
  };

  const merged = mergeSections(options.baseValues ?? {}, mapped);
  return applyTraefikSecurityPins(merged);
}

/**
 * Report configuration that is legal but likely a mistake at an edge.
 *
 * Returns warnings rather than throwing: none of these is invalid, and a test
 * cluster legitimately hits several of them.
 *
 * @param values - Chart values, normally the output of
 *   {@link mapTraefikConfigToHelmValues}.
 */
export function validateTraefikHelmValues(values: TraefikHelmValues): string[] {
  const warnings: string[] = [];

  if (values.api?.dashboard === true) {
    warnings.push(
      'Traefik dashboard is enabled. This factory pins api.dashboard to false; seeing it enabled means the pins were bypassed.'
    );
  }
  if (values.api?.insecure === true) {
    warnings.push(
      'Traefik insecure API is enabled. This factory pins api.insecure to false; seeing it enabled means the pins were bypassed.'
    );
  }
  if (values.podSecurityContext?.runAsNonRoot !== true) {
    warnings.push(
      'Traefik podSecurityContext.runAsNonRoot is not true. The proxy binds unprivileged container ports and does not need root.'
    );
  }
  if (values.providers?.kubernetesCRD?.enabled === false) {
    warnings.push(
      'The Kubernetes CRD provider is disabled. IngressRoute, Middleware, TLSOption, TLSStore and TraefikService resources will not be reconciled.'
    );
  }
  if (values.ingressClass?.isDefaultClass === true) {
    warnings.push(
      'Traefik is claiming the cluster-default IngressClass. Every Ingress without an explicit class will be routed by this installation.'
    );
  }
  if (values.deployment?.replicas === 1 && values.service?.spec?.type === 'LoadBalancer') {
    warnings.push(
      'A single Traefik replica behind a LoadBalancer has no rolling-update headroom. Consider replicas >= 2 for a production edge.'
    );
  }
  if (!values.resources?.requests) {
    warnings.push(
      'No resource requests specified for Traefik. Set CPU and memory requests so the edge is not evicted first under pressure.'
    );
  }
  if (values.ports?.traefik?.expose?.default === true) {
    warnings.push(
      'The internal `traefik` entrypoint is exposed by the Service. It serves /ping and metrics and should stay cluster-internal.'
    );
  }

  return warnings;
}

/**
 * The chart version this factory is verified against.
 *
 * Re-exported from the mapper so a consumer can record the pinned version
 * alongside the values it produced.
 */
export const TRAEFIK_MAPPED_CHART_VERSION = DEFAULT_TRAEFIK_CHART_VERSION;
