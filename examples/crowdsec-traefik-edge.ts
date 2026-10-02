/**
 * CrowdSec Example — protect a Traefik-fronted public API
 *
 * 1. `makeCrowdsecBootstrap` — LAPI (Postgres, two replicas), the agent
 *    DaemonSet reading Traefik's access logs, AppSec with virtual patching and
 *    out-of-band CRS, an allowlist, and global simulation for the first rollout.
 * 2. `makeTraefikBootstrap` — Traefik with the hash-pinned bouncer plugin and
 *    the User-Agent kept in its JSON access log, which the CrowdSec parser reads.
 * 3. `crowdsecBouncerMiddleware` — the bouncer as a Traefik Middleware, first
 *    in the IngressRoute's chain, failing open while CrowdSec is unreachable.
 *
 * Secrets are created out of band (External Secrets, say):
 * - `crowdsec-bouncer` with `api-key`, in BOTH the `crowdsec` and the `traefik`
 *   namespace: LAPI registers the key, the Middleware reads it.
 * - `crowdsec-db` with `password`, in `crowdsec`.
 * - `crowdsec-enroll` with `key`, in `crowdsec`, from the CrowdSec console.
 *
 * Run: `bun run build:examples` typechecks this file.
 */

import { type } from 'arktype';
import { makeCrowdsecBootstrap } from '../src/factories/crowdsec/compositions/crowdsec-bootstrap.js';
import {
  crowdsecBouncerMiddleware,
  crowdsecTraefikPlugin,
} from '../src/factories/crowdsec/index.js';
import { makeTraefikBootstrap } from '../src/factories/traefik/compositions/traefik-bootstrap.js';
import { traefikMiddleware } from '../src/factories/traefik/resources/middleware.js';
import { traefikIngressRoute } from '../src/factories/traefik/resources/routing.js';
import { kubernetesComposition } from '../src/index.js';

const BOUNCER_KEY = { name: 'crowdsec-bouncer', key: 'api-key' };

/** CrowdSec itself. Every option here is build-time and concrete. */
export const exampleCrowdsec = makeCrowdsecBootstrap({
  name: 'example-crowdsec',
  kind: 'ExampleCrowdsec',
  storage: {
    type: 'postgres',
    host: 'crowdsec-db-rw.crowdsec.svc.cluster.local',
    database: 'crowdsec',
    user: 'crowdsec',
    passwordSecretRef: { name: 'crowdsec-db', key: 'password' },
  },
  lapi: { replicas: 2 },
  // The pods `traefikBootstrap` creates for `name: 'traefik'` in `traefik`.
  acquisitions: [{ namespace: 'traefik', podName: 'traefik-*' }],
  collections: ['crowdsecurity/whitelist-good-actors'],
  centralApi: {
    communityBlocklist: true,
    enrollment: { keySecretRef: { name: 'crowdsec-enroll', key: 'key' }, tags: ['edge'] },
  },
  bouncers: [{ name: 'traefik', keySecretRef: BOUNCER_KEY }],
  // Office egress and the uptime checker never get banned.
  allowlist: { cidrs: ['198.51.100.0/24'], ips: ['203.0.113.7'], reason: 'office and probes' },
  // Rollout step 1: everything alerts, nothing bans except known CVE exploits.
  simulation: { global: true, exclusions: ['crowdsecurity/http-cve-probing'] },
  appsec: {
    maxBodySize: 1_048_576,
    // CRS rule 942100 (SQL injection) misfires on binary upload bodies.
    exclusions: [{ ruleId: 942100, pathPrefix: '/v1/uploads', phase: 'outofband' }],
  },
});

/** Traefik with the bouncer plugin, before any route uses it. */
export const exampleEdge = makeTraefikBootstrap({
  name: 'example-crowdsec-edge',
  kind: 'ExampleCrowdsecEdge',
  values: {
    experimental: { plugins: { crowdsec: crowdsecTraefikPlugin() } },
    accessLog: { fields: { headers: { names: { 'User-Agent': 'keep' } } } },
  },
});

/** The API route: the bouncer first, then the backend. */
export const exampleProtectedApi = kubernetesComposition(
  {
    name: 'example-protected-api',
    kind: 'ExampleProtectedApi',
    spec: type({ lapiHost: 'string', appsecHost: 'string', host: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const bouncer = traefikMiddleware({
      name: 'crowdsec',
      namespace: 'traefik',
      spec: crowdsecBouncerMiddleware({
        lapiHost: spec.lapiHost,
        appsecHost: spec.appsecHost,
        apiKeySecret: BOUNCER_KEY,
        appsecBodyLimit: 1_048_576,
        // The NLB in front of Traefik, when it does not use PROXY protocol.
        forwardedHeadersTrustedIps: ['10.0.0.0/8'],
      }),
      id: 'crowdsecBouncer',
    });

    const route = traefikIngressRoute({
      name: 'example-api',
      namespace: 'traefik',
      spec: {
        entryPoints: ['websecure'],
        ingressClassName: 'traefik',
        tls: { secretName: 'example-api-tls' },
        routes: [
          {
            match: `Host(\`${spec.host}\`)`,
            kind: 'Rule',
            middlewares: [{ name: 'crowdsec' }],
            services: [{ name: 'example-api', namespace: 'api', port: 8080 }],
          },
        ],
      },
      id: 'exampleApiRoute',
    });
    route.dependsOn(bouncer);

    return { ready: true };
  }
);
