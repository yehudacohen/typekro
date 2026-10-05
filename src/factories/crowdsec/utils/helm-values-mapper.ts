/**
 * CrowdSec Helm values mapping for the official `crowdsec` chart 0.24.2.
 *
 * The detection policy (acquisitions, collections, allowlist, simulation,
 * AppSec) is rendered into CrowdSec config FILES, so it comes from the
 * build-time options and is always concrete. The runtime spec only supplies
 * values that land in the tree as-is (names, resources, replicas), which may be
 * schema references in KRO mode and are never branched on here.
 */

import { dump } from 'js-yaml';

import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  CROWDSEC_APPSEC_PORT,
  CROWDSEC_KUBECTL_IMAGE_TAG,
  DEFAULT_CROWDSEC_COLLECTIONS,
} from '../constants.js';
import type {
  CrowdsecAcquisition,
  CrowdsecAppsecExclusion,
  CrowdsecBootstrapConfig,
  CrowdsecBootstrapOptions,
  CrowdsecPlacement,
  CrowdsecResources,
} from '../types.js';
import { isCidr, isIp } from './net.js';

// Defaults sized from a kind run with the Traefik collections and CRS loaded.
// Requests are always set so no CrowdSec pod is BestEffort. No CPU limits:
// AppSec sits on the request path, and throttling LAPI delays every pull.
const DEFAULT_LAPI_RESOURCES: CrowdsecResources = {
  requests: { cpu: '100m', memory: '256Mi' },
  limits: { memory: '512Mi' },
};
const DEFAULT_AGENT_RESOURCES: CrowdsecResources = {
  requests: { cpu: '100m', memory: '192Mi' },
  limits: { memory: '384Mi' },
};
const DEFAULT_APPSEC_RESOURCES: CrowdsecResources = {
  requests: { cpu: '200m', memory: '384Mi' },
  limits: { memory: '768Mi' },
};

// The chart's own default for `api.server.auto_registration.allowed_ranges`.
const DEFAULT_AUTO_REGISTRATION_RANGES = [
  '127.0.0.1/32',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
];

/** Default acquisition: the pods `traefikBootstrap` creates with its defaults. */
export const DEFAULT_CROWDSEC_ACQUISITIONS: readonly CrowdsecAcquisition[] = [
  { namespace: 'traefik', podName: 'traefik-*' },
];

/** File names this factory writes into the chart's config maps. */
export const CROWDSEC_GENERATED_FILES = {
  allowlist: 'typekro-allowlist.yaml',
  appsecPolicy: 'typekro-appsec-policy.yaml',
} as const;

/** Name of the AppSec config holding the body limit and the exclusions. */
export const CROWDSEC_APPSEC_POLICY_NAME = 'typekro/appsec-policy';

const BOUNCER_NAME = /^[A-Za-z0-9_]+$/;
const DNS_LABEL = /^(?=.{1,63}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

function fail(message: string, context?: Record<string, unknown>): never {
  throw new TypeKroError(message, 'CROWDSEC_INVALID_OPTIONS', context);
}

// Every option string lands in the values tree, where KRO would read `${` as CEL.
function assertNoCel(options: CrowdsecBootstrapOptions): void {
  const strings: (string | undefined)[] = [
    options.allowlist?.reason,
    options.centralApi?.enrollment?.instanceName,
    ...(options.centralApi?.enrollment?.tags ?? []),
    ...(options.collections ?? []),
    ...(options.simulation?.global ? (options.simulation.enforce ?? []) : []),
    ...(options.simulation && !options.simulation.global
      ? (options.simulation.simulate ?? [])
      : []),
    ...(options.lapi?.autoRegistrationRanges ?? []),
    ...(options.appsec?.exclusions ?? []).flatMap((e) => [e.ruleName, e.ruleTag, e.pathPrefix]),
    ...(options.storage?.type === 'postgres'
      ? [options.storage.host, options.storage.database, options.storage.user]
      : []),
    ...[...(options.lapi?.env ?? []), ...(options.agent?.env ?? [])].flatMap((env) => [
      env.name,
      env.value,
      JSON.stringify(env.valueFrom ?? null),
    ]),
    options.networkPolicy?.traefikNamespace,
    options.networkPolicy?.metricsNamespace,
  ];
  for (const value of strings) {
    if (value?.includes('${')) fail(`"${value}" contains "\${", which KRO would parse as CEL.`);
  }
}

/**
 * Throw on option combinations the chart would accept but CrowdSec would run
 * wrongly, or not at all.
 *
 * @throws {TypeKroError} `CROWDSEC_INVALID_OPTIONS`
 */
export function assertCrowdsecBootstrapOptions(options: CrowdsecBootstrapOptions): void {
  assertNoCel(options);
  const storage = options.storage ?? { type: 'sqlite' };
  const replicas = options.lapi?.replicas ?? 1;
  if (!Number.isInteger(replicas) || replicas < 1) {
    fail(`lapi.replicas must be a positive integer, got ${replicas}.`);
  }
  if (replicas > 1 && storage.type === 'sqlite') {
    fail(
      'lapi.replicas > 1 needs storage.type "postgres": SQLite lives on one ReadWriteOnce volume.'
    );
  }

  const acquisitions = options.acquisitions ?? DEFAULT_CROWDSEC_ACQUISITIONS;
  if (acquisitions.length === 0) fail('At least one acquisition is required.');
  for (const acquisition of acquisitions) {
    // The chart interpolates both into a file glob.
    if (
      !/^[a-z0-9*?.-]+$/.test(acquisition.podName) ||
      !/^[a-z0-9-]+$/.test(acquisition.namespace)
    ) {
      fail(
        `Acquisition ${acquisition.namespace}/${acquisition.podName} is not a namespace and pod-name glob.`
      );
    }
  }

  for (const namespace of [
    options.networkPolicy?.traefikNamespace,
    options.networkPolicy?.metricsNamespace,
  ]) {
    if (namespace !== undefined && !DNS_LABEL.test(namespace)) {
      fail(`networkPolicy namespace "${namespace}" is not a DNS-1123 label.`);
    }
  }

  const names = new Set<string>();
  for (const bouncer of options.bouncers ?? []) {
    if (!BOUNCER_NAME.test(bouncer.name)) {
      fail(`Bouncer name "${bouncer.name}" must match ${BOUNCER_NAME}; it becomes an env var.`);
    }
    if (names.has(bouncer.name)) fail(`Bouncer "${bouncer.name}" is declared twice.`);
    names.add(bouncer.name);
  }

  for (const ip of options.allowlist?.ips ?? []) {
    if (!isIp(ip)) fail(`Allowlist IP "${ip}" is not an IPv4 or IPv6 address.`);
  }
  for (const cidr of options.allowlist?.cidrs ?? []) {
    if (!isCidr(cidr)) fail(`Allowlist CIDR "${cidr}" is not a valid range.`);
  }

  // The bouncer talks plain http to LAPI; with chart TLS on it could not
  // connect, and a fail-open bouncer would then let everything through.
  const rawTls = (options.values as { tls?: { enabled?: unknown } } | undefined)?.tls;
  if (rawTls?.enabled === true) {
    fail('values.tls.enabled is not supported: the Traefik bouncer reaches LAPI over http.');
  }

  const enrollment = options.centralApi?.enrollment;
  if (enrollment?.tags?.some((tag) => /\s/.test(tag) || tag.length === 0)) {
    fail('Enrollment tags must be non-empty and contain no whitespace.');
  }

  const appsec = options.appsec;
  if (appsec) {
    if (appsec.virtualPatching === false && appsec.crs === false) {
      fail('appsec needs virtualPatching or crs; omit appsec to disable it.');
    }
    const size = appsec.maxBodySize;
    if (size !== undefined && (!Number.isInteger(size) || size <= 0)) {
      fail(`appsec.maxBodySize must be a positive integer, got ${size}.`);
    }
    for (const exclusion of appsec.exclusions ?? []) {
      const selectors = [exclusion.ruleId, exclusion.ruleName, exclusion.ruleTag].filter(
        (value) => value !== undefined
      );
      if (selectors.length !== 1) {
        fail('Each appsec exclusion sets exactly one of ruleId, ruleName or ruleTag.');
      }
      for (const text of [exclusion.ruleName, exclusion.ruleTag, exclusion.pathPrefix]) {
        if (text !== undefined && /['"\\\n]/.test(text)) {
          fail(`Appsec exclusion value "${text}" may not contain quotes, backslashes or newlines.`);
        }
      }
      if (exclusion.pathPrefix !== undefined && !exclusion.pathPrefix.startsWith('/')) {
        fail(`Appsec exclusion pathPrefix "${exclusion.pathPrefix}" must start with "/".`);
      }
    }
  }
}

function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !isGraphValue(value)
  );
}

// Deep merge where refs, CEL and arrays are leaves and `override` wins.
function merge(base: Record<string, unknown>, override: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? merge(current, value) : value;
  }
  return result;
}

function yaml(value: unknown, quoted = false): string {
  return dump(value, { lineWidth: -1, noRefs: true, forceQuotes: quoted, quotingType: '"' });
}

function placementValues(
  placement: CrowdsecPlacement | undefined,
  defaultSpread: Record<string, unknown>[] | undefined
): Record<string, unknown> {
  const spread = placement?.topologySpreadConstraints ?? defaultSpread;
  return {
    ...(placement?.nodeSelector ? { nodeSelector: { ...placement.nodeSelector } } : {}),
    ...(placement?.tolerations ? { tolerations: [...placement.tolerations] } : {}),
    ...(placement?.affinity ? { affinity: placement.affinity } : {}),
    ...(spread ? { topologySpreadConstraints: [...spread] } : {}),
    ...(placement?.priorityClassName ? { priorityClassName: placement.priorityClassName } : {}),
  };
}

function softSpread(name: unknown, component: string): Record<string, unknown>[] {
  return [
    {
      maxSkew: 1,
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'ScheduleAnyway',
      labelSelector: { matchLabels: { 'k8s-app': name, type: component } },
    },
  ];
}

function secretEnv(name: string, ref: { name: string; key: string }) {
  return { name, valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } } };
}

/** The parser (and postoverflow) whitelist this factory renders, or `undefined`. */
export function renderCrowdsecAllowlist(
  allowlist: CrowdsecBootstrapOptions['allowlist']
): string | undefined {
  const ips = allowlist?.ips ?? [];
  const cidrs = allowlist?.cidrs ?? [];
  if (ips.length === 0 && cidrs.length === 0) return undefined;
  return yaml({
    name: 'typekro/allowlist',
    description: 'IPs and ranges allowlisted by the TypeKro CrowdSec bootstrap',
    whitelist: {
      reason: allowlist?.reason ?? 'typekro allowlist',
      ...(ips.length > 0 ? { ip: [...ips] } : {}),
      ...(cidrs.length > 0 ? { cidr: [...cidrs] } : {}),
    },
  });
}

/** `simulation.yaml`, or `''` when simulation is not configured. */
export function renderCrowdsecSimulation(
  simulation: CrowdsecBootstrapOptions['simulation']
): string {
  if (!simulation) return '';
  // CrowdSec's `exclusions` invert the global flag: under global simulation
  // they enforce, otherwise they are the only scenarios simulated.
  const exclusions = simulation.global ? simulation.enforce : simulation.simulate;
  return yaml({ simulation: simulation.global, exclusions: [...(exclusions ?? [])] });
}

function exclusionCall(exclusion: CrowdsecAppsecExclusion, band: 'InBand' | 'OutBand'): string {
  if (exclusion.ruleId !== undefined) return `Remove${band}RuleByID(${exclusion.ruleId})`;
  if (exclusion.ruleName !== undefined) return `Remove${band}RuleByName('${exclusion.ruleName}')`;
  return `Remove${band}RuleByTag('${exclusion.ruleTag}')`;
}

/** The AppSec config carrying the body limit and the rule exclusions. */
export function renderCrowdsecAppsecPolicy(options: CrowdsecBootstrapOptions): string {
  const appsec = options.appsec ?? {};
  const remediation = appsec.inBandRemediation ?? (options.simulation?.global ? 'allow' : 'ban');
  const onLoad: string[] = [
    `SetMaxBodySize(${appsec.maxBodySize ?? 10_485_760})`,
    `SetBodySizeExceededAction('${appsec.bodySizeExceededAction ?? 'partial'}')`,
  ];
  const preEval: { filter: string; apply: string[] }[] = [];
  for (const exclusion of appsec.exclusions ?? []) {
    const phase = exclusion.phase ?? 'both';
    const calls = [
      ...(phase === 'outofband' ? [] : [exclusionCall(exclusion, 'InBand')]),
      ...(phase === 'inband' ? [] : [exclusionCall(exclusion, 'OutBand')]),
    ];
    if (exclusion.pathPrefix === undefined) onLoad.push(...calls);
    else
      preEval.push({ filter: `req.URL.Path startsWith '${exclusion.pathPrefix}'`, apply: calls });
  }
  return yaml({
    name: CROWDSEC_APPSEC_POLICY_NAME,
    // Loaded last, so it sets the remediation for every config before it.
    default_remediation: remediation,
    on_load: [{ apply: onLoad }],
    ...(preEval.length > 0 ? { pre_eval: preEval } : {}),
  });
}

function clusterIpOnly(): Record<string, unknown> {
  return { type: 'ClusterIP', externalIPs: [], loadBalancerIP: '', loadBalancerClass: '' };
}

const DB_PASSWORD_VAR = '$DB_PASSWORD';

function configYamlLocal(options: CrowdsecBootstrapOptions): string {
  const storage = options.storage ?? { type: 'sqlite' };
  const server: Record<string, unknown> = {
    auto_registration: {
      enabled: true,
      // CrowdSec expands `$VAR` from the env. Not `${VAR}`: KRO would parse it as CEL.
      token: '$REGISTRATION_TOKEN',
      allowed_ranges: [
        ...(options.lapi?.autoRegistrationRanges ?? DEFAULT_AUTO_REGISTRATION_RANGES),
      ],
    },
  };
  if (options.centralApi && options.centralApi.communityBlocklist === false) {
    server.online_client = { pull: { community: false } };
  }
  // CrowdSec expands `$VAR` in the file text BEFORE parsing the YAML, so the
  // password lands in the file verbatim. A literal block scalar with an
  // explicit indentation indicator (`|2-`) carries any single-line value as is,
  // quotes, backslashes, `#`, flow and sequence indicators and leading or
  // trailing spaces included; only a newline cannot be carried, which the docs
  // state (the value lives in a Secret, so it cannot be checked here).
  return yaml(
    {
      api: { server },
      ...(storage.type === 'postgres'
        ? {
            db_config: {
              type: 'postgresql',
              user: storage.user,
              password: DB_PASSWORD_VAR,
              db_name: storage.database,
              host: storage.host,
              port: storage.port ?? 5432,
              sslmode: storage.sslMode ?? 'require',
            },
          }
        : {}),
    },
    true
  ).replace(
    /^( *)password: "\$DB_PASSWORD"$/m,
    (_, indent: string) => `${indent}password: |2-\n${indent}  ${DB_PASSWORD_VAR}`
  );
}

function collections(options: CrowdsecBootstrapOptions): string {
  return [...new Set([...DEFAULT_CROWDSEC_COLLECTIONS, ...(options.collections ?? [])])].join(' ');
}

/**
 * Map the runtime spec and the build options to chart values.
 *
 * `options.values` is merged first; the mapped values win, and the network
 * pins (no LAPI Ingress, ClusterIP Services only) are applied last.
 */
export function mapCrowdsecConfigToHelmValues(
  spec: CrowdsecBootstrapConfig,
  options: CrowdsecBootstrapOptions = {}
): Record<string, unknown> {
  assertCrowdsecBootstrapOptions(options);
  const storage = options.storage ?? { type: 'sqlite' };
  const sqlite = storage.type === 'sqlite';
  const acquisitions = options.acquisitions ?? DEFAULT_CROWDSEC_ACQUISITIONS;
  const capi = options.centralApi !== undefined;
  const appsec = options.appsec;
  const allowlist = renderCrowdsecAllowlist(options.allowlist);
  const simulation = renderCrowdsecSimulation(options.simulation);
  const metrics = {
    enabled: true,
    serviceMonitor: { enabled: options.metrics?.serviceMonitor ?? false },
    podMonitor: { enabled: options.metrics?.podMonitor ?? false },
  };

  const lapiEnv: object[] = [];
  if (!capi) lapiEnv.push({ name: 'DISABLE_ONLINE_API', value: 'true' });
  const enrollment = options.centralApi?.enrollment;
  if (enrollment) {
    lapiEnv.push(secretEnv('ENROLL_KEY', enrollment.keySecretRef));
    if (enrollment.instanceName) {
      lapiEnv.push({ name: 'ENROLL_INSTANCE_NAME', value: enrollment.instanceName });
    }
    if (enrollment.tags?.length)
      lapiEnv.push({ name: 'ENROLL_TAGS', value: enrollment.tags.join(' ') });
  }
  for (const bouncer of options.bouncers ?? []) {
    lapiEnv.push(secretEnv(`BOUNCER_KEY_${bouncer.name}`, bouncer.keySecretRef));
  }
  if (storage.type === 'postgres')
    lapiEnv.push(secretEnv('DB_PASSWORD', storage.passwordSecretRef));
  lapiEnv.push(...(options.lapi?.env ?? []));

  const mapped: Record<string, unknown> = {
    container_runtime: options.agent?.containerRuntime ?? 'containerd',
    // Upstream defaults the register Jobs' kubectl image to `latest`.
    image: { kubectl: { tag: CROWDSEC_KUBECTL_IMAGE_TAG } },
    config: {
      parsers: {
        's02-enrich': allowlist ? { [CROWDSEC_GENERATED_FILES.allowlist]: allowlist } : {},
      },
      'simulation.yaml': simulation,
      'config.yaml.local': configYamlLocal(options),
    },
    lapi: {
      replicas: options.lapi?.replicas ?? 1,
      env: lapiEnv,
      resources: Cel.default(spec.lapi?.resources, DEFAULT_LAPI_RESOURCES),
      // SQLite on one RWO volume cannot overlap two pods during a rollout.
      strategy: { type: sqlite ? 'Recreate' : 'RollingUpdate' },
      persistentVolume: {
        data: {
          enabled: sqlite,
          ...(sqlite && storage.size ? { size: storage.size } : {}),
          ...(sqlite && storage.storageClassName
            ? { storageClassName: storage.storageClassName }
            : {}),
        },
        // Config comes from values, never from a stale copy on a volume.
        config: { enabled: false },
      },
      // Credentials in Secrets let replicas share one identity. The chart only
      // grants its register Jobs RBAC when CAPI is on, so both follow it.
      storeCAPICredentialsInSecret: capi,
      storeLAPICscliCredentialsInSecret: capi,
      metrics,
      ...placementValues(options.lapi?.placement, softSpread(spec.name, 'lapi')),
    },
    agent: {
      isDeployment: false,
      acquisition: acquisitions.map((a) => ({
        namespace: a.namespace,
        podName: a.podName,
        program: a.program ?? 'traefik',
      })),
      env: [{ name: 'COLLECTIONS', value: collections(options) }, ...(options.agent?.env ?? [])],
      resources: Cel.default(spec.agent?.resources, DEFAULT_AGENT_RESOURCES),
      metrics,
      ...placementValues(options.agent?.placement, undefined),
    },
    appsec: appsec
      ? appsecValues(spec, options, allowlist, simulation, metrics)
      : { enabled: false },
  };

  const merged = merge({ ...(options.values ?? {}) }, mapped);
  return merge(merged, {
    // @security LAPI holds every bouncer key and decision: never published.
    // ClusterIP alone is not enough: the chart also renders `externalIPs`,
    // `loadBalancerIP` and `loadBalancerClass` from values, whatever the type.
    lapi: { ingress: { enabled: false }, service: clusterIpOnly() },
    agent: { service: clusterIpOnly() },
    appsec: { service: clusterIpOnly() },
    // @security The bouncer speaks http to LAPI (see assertCrowdsecBootstrapOptions).
    tls: { enabled: false },
  });
}

function appsecValues(
  spec: CrowdsecBootstrapConfig,
  options: CrowdsecBootstrapOptions,
  allowlist: string | undefined,
  simulation: string,
  metrics: Record<string, unknown>
): Record<string, unknown> {
  const appsec = options.appsec ?? {};
  const configs = [
    ...(appsec.virtualPatching === false ? [] : ['crowdsecurity/appsec-default']),
    ...(appsec.crs === false ? [] : ['crowdsecurity/crs']),
    CROWDSEC_APPSEC_POLICY_NAME,
  ];
  const appsecCollections = [
    // `appsec-default` loads rules from both of these collections.
    ...(appsec.virtualPatching === false
      ? []
      : ['crowdsecurity/appsec-virtual-patching', 'crowdsecurity/appsec-generic-rules']),
    ...(appsec.crs === false ? [] : ['crowdsecurity/appsec-crs']),
  ];
  return {
    enabled: true,
    replicas: Cel.default(spec.appsec?.replicas, 1),
    strategy: { type: 'RollingUpdate' },
    acquisitions: [
      {
        source: 'appsec',
        listen_addr: `0.0.0.0:${CROWDSEC_APPSEC_PORT}`,
        path: '/',
        appsec_configs: configs,
        labels: { type: 'appsec' },
      },
    ],
    configs: { [CROWDSEC_GENERATED_FILES.appsecPolicy]: renderCrowdsecAppsecPolicy(options) },
    env: [{ name: 'COLLECTIONS', value: appsecCollections.join(' ') }],
    // The chart mounts parsers only on agents; AppSec alerts are allowlisted
    // after the overflow instead.
    postoverflows: {
      's01-whitelist': allowlist ? { [CROWDSEC_GENERATED_FILES.allowlist]: allowlist } : {},
    },
    // The chart mounts simulation.yaml only on agents; AppSec scenarios
    // (out-of-band CRS bans) must honour it too.
    ...(simulation
      ? {
          extraVolumes: [
            { name: 'typekro-simulation', configMap: { name: 'crowdsec-simulation' } },
          ],
          extraVolumeMounts: [
            {
              name: 'typekro-simulation',
              mountPath: '/etc/crowdsec/simulation.yaml',
              subPath: 'simulation.yaml',
            },
          ],
        }
      : {}),
    resources: Cel.default(spec.appsec?.resources, DEFAULT_APPSEC_RESOURCES),
    metrics,
    ...placementValues(appsec.placement, softSpread(spec.name, 'appsec')),
  };
}
