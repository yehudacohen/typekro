import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import {
  dagsterBootstrap,
  dagsterHelmRepositoryBootstrap,
} from '../../../src/factories/dagster/index.js';
import {
  DagsterBootstrapConfigSchema,
  DagsterBootstrapStatusSchema,
} from '../../../src/factories/dagster/types.js';

// Test decision: use the Dagster package barrel for bootstrap behavior so this
// suite catches missing public wiring, not only a helper-only composition file.
// Direct composition imports were rejected because `typekro/dagster` is the
// approved user-facing seam.
describe('Dagster bootstrap composition', () => {
  it('Accept valid Dagster bootstrap config through the config schema', () => {
    const result = DagsterBootstrapConfigSchema({
      name: 'analytics',
      namespace: 'dagster',
      version: '1.13.8',
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'analytics-repo',
            image: {
              repository: 'ghcr.io/acme/dagster-analytics',
              tag: '2026.06.01',
            },
            codeServerArgs: ['-m', 'analytics.definitions'],
          },
        ],
      },
      postgresql: {
        enabled: false,
        host: 'dagster-postgres.postgres.svc.cluster.local',
        username: 'dagster',
        database: 'dagster',
        passwordSecretName: 'dagster-postgres',
      },
      runLauncher: {
        type: 'K8sRunLauncher',
        k8sRunLauncher: { jobNamespace: 'dagster-runs' },
      },
      ingress: {
        enabled: true,
        dagsterWebserver: { host: 'dagster.example.com' },
      },
      values: { busybox: { image: { tag: '1.36' } } },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Expose Dagster bootstrap status fields from owned Helm resources', () => {
    const result = DagsterBootstrapStatusSchema({
      ready: true,
      phase: 'Ready',
      failed: false,
      version: '1.13.8',
      components: {
        helmRepository: true,
        helmRelease: true,
        webserver: true,
        daemon: true,
        userDeployments: true,
      },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Generate ResourceGraphDefinition YAML with owned resources and status CEL', () => {
    const yaml = dagsterBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: dagster-bootstrap');
    expect(yaml).toContain('dagsterNamespace');
    expect(yaml).toContain('dagsterHelmRelease');
    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: HelmRelease');
    // The HelmRepository is a shared cluster-level singleton referenced via
    // externalRef (not owned per-instance), so a dev + prod pair of instances
    // doesn't collide on KRO's per-instance ApplySet ownership of it.
    expect(yaml).toContain('externalRef');
    expect(yaml).toContain('kind: DagsterHelmRepository');
    // sourceRef still points the HelmRelease at the (shared) HelmRepository.
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('chart: dagster');
    expect(yaml).toContain('1.13.8');
    // Honest readiness: `ready` now combines the HelmRelease Ready condition AND
    // the observed webserver Deployment status (null-safe via has()).
    expect(yaml).toContain('ready: ${(dagsterHelmRelease.status.conditions');
    expect(yaml).toContain('dagsterWebserverDeployment.status.availableReplicas');
    expect(yaml).toContain('phase: "${dagsterHelmRelease.status.conditions');
    // The webserver is OBSERVED via externalRef (apps/v1 Deployment), not owned —
    // so a `kind: Deployment` externalRef is expected, but no owned Deployment
    // template (the chart owns the real workloads).
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).not.toContain('kind: Pod');
    // The observed webserver Deployment is named from the chart's `.Release.Name` (= spec.name)
    // + the chart-default `-dagster-webserver` suffix. Pin that derivation so a regression to the
    // WRONG base — `dagster.fullname` (the global-override-aware helper, which appends `-dagster`
    // for a release name not containing "dagster" and would observe a nonexistent Deployment,
    // hanging `ready` forever) — fails loudly.
    expect(yaml).toContain('schema.spec.name + "-dagster-webserver"');
    // The buggy derivation used `dagster.fullname`'s `contains(...)` logic in the name. That doesn't
    // belong in the webserver name; its presence is the regression. (We can't assert on `fullnameOverride`
    // here — it legitimately appears in the HelmRelease values passthrough, unrelated to the name.)
    expect(yaml).not.toContain('.contains(');
  });

  it('Own the shared HelmRepository in the singleton composition', () => {
    // The repository moved out of the per-instance bootstrap RGD into a shared
    // singleton composition (kind DagsterHelmRepository) that owns the actual
    // HelmRepository. Its URL is templated from the singleton spec; the concrete
    // official URL is supplied by dagsterBootstrap at the singleton() call site.
    const repoYaml = dagsterHelmRepositoryBootstrap.toYaml();

    expect(repoYaml).toContain('kind: ResourceGraphDefinition');
    expect(repoYaml).toContain('kind: DagsterHelmRepository');
    expect(repoYaml).toContain('kind: HelmRepository');
    expect(repoYaml).toContain('url: ${schema.spec.url}');
  });

  it('Emit the HelmRepository singleton owner in the GitOps toYaml bundle', () => {
    // The bootstrap RGD only externalRefs the shared DagsterHelmRepository singleton.
    // For a GitOps apply to be complete, toYaml() must also emit the singleton owner
    // RGD (deps-first) and toYaml(spec) the owner instance (with the spec-fingerprint
    // annotation that deploy() writes), or the externalRef dangles.
    const rgdBundle = dagsterBootstrap.toYaml();
    const rgdDocs = rgdBundle.split(/^---$/m).map((doc) => doc.trim());
    expect(rgdDocs).toHaveLength(2);
    expect(rgdBundle).toContain('name: dagster-helm-repository');
    expect(rgdBundle).toContain('name: dagster-bootstrap');
    // Owner RGD before the consuming RGD (deps-first apply order).
    expect(rgdBundle.indexOf('name: dagster-helm-repository')).toBeLessThan(
      rgdBundle.indexOf('name: dagster-bootstrap')
    );

    const instanceBundle = dagsterBootstrap
      .factory('kro', { namespace: 'dagster' })
      .toYaml({ name: 'analytics', namespace: 'dagster', postgresql: { enabled: true } } as never);
    expect(instanceBundle).toContain('kind: DagsterHelmRepository');
    expect(instanceBundle).toContain('namespace: typekro-singletons');
    expect(instanceBundle).toContain('typekro.io/singleton-spec-fingerprint');
    expect(instanceBundle).toContain('kind: DagsterBootstrap');
  });

  it('Preserve graph-aware Helm values in ResourceGraphDefinition YAML without raw markers', () => {
    const yaml = dagsterBootstrap.toYaml();

    expect(yaml).toContain('schema.spec.values');
    expect(yaml).toContain('json.unmarshal(json.marshal(schema.spec.values))');
    expect(yaml).toContain('schema.spec.userDeployments.deployments');
    expect(yaml).toContain('schema.spec.webserver.image');
    expect(yaml).toContain('schema.spec.daemon.image');
    expect(yaml).toContain('schema.spec.global.dagsterHome');
    expect(yaml).toContain('schema.spec.global.celeryConfigSecretName');
    expect(yaml).toContain('schema.spec.global.serviceAccountName');
    expect(yaml).toContain('schema.spec.global.postgresqlSecretName');
    expect(yaml).toContain('schema.spec.global.dagsterInstanceConfigMap');
    expect(yaml).toContain(
      'has(schema.spec.serviceAccountName) ? schema.spec.serviceAccountName : has(schema.spec.global) && has(schema.spec.global.serviceAccountName) ? schema.spec.global.serviceAccountName : omit()'
    );
    expect(yaml).toContain(
      'has(schema.spec.postgresql) && has(schema.spec.postgresql.passwordSecretName) ? schema.spec.postgresql.passwordSecretName : has(schema.spec.global) && has(schema.spec.global.postgresqlSecretName) ? schema.spec.global.postgresqlSecretName : omit()'
    );
    expect(yaml).toContain('schema.spec.postgresql.values');
    expect(yaml).toContain('schema.spec.rabbitmq.values');
    expect(yaml).toContain('schema.spec.redis.values');
    expect(yaml).toContain('postgresqlHost');
    expect(yaml).toContain('k8sRunLauncher');
    expect(yaml).toContain(
      'has(schema.spec.postgresql) && has(schema.spec.postgresql.passwordSecretName) ? false : omit()'
    );
    expect(yaml).not.toContain('\\"deployments\\": [(has(schema.spec.userDeployments');
    expect(yaml).not.toContain('\\"imagePullSecrets\\": [(has(schema.spec.imagePullSecrets');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
    expect(yaml).not.toContain('__typekroSchemaKey');
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('undefined');
  });

  it('Reject KRO instance YAML with invalid typed user deployment arguments', () => {
    const factory = dagsterBootstrap.factory('kro', {
      namespace: 'typekro-dagster-test',
    });

    expect(() =>
      factory.toYaml({
        name: 'broken-dagster',
        namespace: 'dagster-broken',
        userDeployments: {
          enabled: true,
          deployments: [
            {
              name: 'broken-repo',
              image: { repository: 'ghcr.io/acme/broken', tag: '1' },
            },
          ],
        },
      })
    ).toThrow(/exactly one of dagsterApiGrpcArgs or codeServerArgs|user deployment/);
  });

  it('Generate direct-mode YAML with Dagster deployment values', async () => {
    const factory = dagsterBootstrap.factory('direct', {
      namespace: 'typekro-dagster-test',
    });
    const yaml = await factory.toYaml({
      name: 'analytics',
      namespace: 'dagster-analytics',
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'analytics-repo',
            image: {
              repository: 'ghcr.io/acme/dagster-analytics',
              tag: '2026.06.01',
            },
            dagsterApiGrpcArgs: ['-m', 'analytics.grpc'],
          },
        ],
      },
      postgresql: {
        enabled: false,
        host: 'dagster-postgres.postgres.svc.cluster.local',
        username: 'dagster',
        database: 'dagster',
        passwordSecretName: 'dagster-postgres',
      },
      runLauncher: {
        type: 'K8sRunLauncher',
        k8sRunLauncher: { jobNamespace: 'dagster-runs' },
      },
      values: {
        busybox: { image: { repository: 'busybox', tag: '1.36' } },
      },
    });

    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('ghcr.io/acme/dagster-analytics');
    expect(yaml).toContain('analytics.grpc');
    expect(yaml).toContain('dagster-postgres.postgres.svc.cluster.local');
    expect(yaml).toContain('dagster-postgres');
    expect(yaml).toContain('K8sRunLauncher');
    expect(yaml).toContain('dagster-runs');
    expect(yaml).toContain('busybox');
    expect(yaml).not.toContain('undefined');
    expect(yaml).not.toContain('[object Object]');
  });
});

describe('Dagster bootstrap honest readiness', () => {
  // The webserver is the one workload the chart ALWAYS deploys for every
  // instance, so it is observed via externalRef and folded into `ready`.
  it('Observe the webserver Deployment via externalRef and reference its status in ready', () => {
    const yaml = dagsterBootstrap.toYaml();

    // The webserver is referenced as an apps/v1 Deployment externalRef (observed,
    // not owned — there is no Deployment *template* in the RGD).
    expect(yaml).toContain('id: dagsterWebserverDeployment');
    expect(yaml).toContain('apiVersion: apps/v1');
    expect(yaml).toContain('kind: Deployment');

    // The webserver name is `<Release.Name>-dagster-webserver`, and the chart's Release.Name is the
    // composition's `spec.name` — so the externalRef name resolves (at instance time) to a clean CEL
    // expression over `spec.name`, with NO leaked ref markers and NO spurious has()-guard wrapper.
    // It must NOT use the chart's `dagster.fullname`/`contains` logic (that helper is for the daemon/
    // postgres names; using it for the webserver would observe a nonexistent Deployment — see the
    // composition comment).
    expect(yaml).toContain('${schema.spec.name + "-dagster-webserver"}');
    expect(yaml).not.toContain('schema.spec.name.contains(');
    expect(yaml).not.toContain('__KUBERNETES_REF__');

    // `ready` is the HelmRelease Ready condition AND the (null-safe) webserver
    // Deployment status. has() guards mean it is `false`, never an eval error,
    // before the Deployment exists during install.
    expect(yaml).toContain('ready: ${(dagsterHelmRelease.status.conditions');
    expect(yaml).toContain('has(dagsterWebserverDeployment.status)');
    expect(yaml).toContain('has(dagsterWebserverDeployment.status.availableReplicas)');
    expect(yaml).toContain('dagsterWebserverDeployment.status.availableReplicas >= 1');
  });

  // Hang-safety: a workload that an instance does NOT deploy must never appear in
  // `ready`. The daemon (conditionally deployed) and the postgres StatefulSet
  // (only when bundled) are deliberately NOT observed in the shared KRO RGD — KRO
  // status CEL cannot reference schema.spec to re-gate them per instance, so
  // requiring them would hang any instance that disables the daemon or uses an
  // external DB. They stay on the HelmRelease signal.
  it('Do NOT observe or require the daemon or postgres (no-hang for disabled/external)', () => {
    const yaml = dagsterBootstrap.toYaml();

    // No externalRef observation for daemon or postgres.
    expect(yaml).not.toContain('dagsterDaemonDeployment');
    expect(yaml).not.toContain('dagsterPostgresStatefulSet');
    // ...so `ready` cannot reference them and cannot hang on an absent workload.
    expect(yaml).not.toContain('Daemon.status');
    expect(yaml).not.toContain('Postgres.status');
    expect(yaml).not.toContain('kind: StatefulSet');

    // No conditional externalRef placeholder leaked into the RGD.
    expect(yaml).not.toContain('kind: ExternalRef');

    // daemon/userDeployments components fall back to the HelmRelease signal.
    expect(yaml).toContain('daemon: ${dagsterHelmRelease.status.conditions');
    expect(yaml).toContain('userDeployments: ${dagsterHelmRelease.status.conditions');
  });

  it('Resolve the webserver name CEL to the live-verified value for release "dagster"', () => {
    // Mirror of the emitted CEL fullname rule, validated against the live cluster
    // observation: release `dagster` (chart `dagster`) → `dagster-dagster-webserver`.
    const webserverName = (
      name: string,
      nameOverride?: string,
      fullnameOverride?: string
    ): string => {
      const chartName = nameOverride ?? 'dagster';
      const fullname =
        fullnameOverride ?? (name.includes(chartName) ? name : `${name}-${chartName}`);
      return `${fullname}-dagster-webserver`;
    };

    expect(webserverName('dagster')).toBe('dagster-dagster-webserver');
    expect(webserverName('analytics')).toBe('analytics-dagster-dagster-webserver');
    expect(webserverName('x', undefined, 'foo')).toBe('foo-dagster-webserver');
    expect(webserverName('ds-prod', 'ds')).toBe('ds-prod-dagster-webserver');
  });

  it('Keep phase/failed/version unchanged', () => {
    const yaml = dagsterBootstrap.toYaml();
    expect(yaml).toContain('phase: "${dagsterHelmRelease.status.conditions');
    expect(yaml).toContain('failed: ${dagsterHelmRelease.status.conditions');
    // `version` is a static/client-hydrated status field, so the RGD schema types
    // it (not the literal value); the default value still flows through templates.
    expect(yaml).toContain('version: string');
    expect(yaml).toContain('1.13.8');
  });
});

describe('Dagster bootstrap default daemon liveness probe', () => {
  async function daemonValues(spec: object): Promise<Record<string, unknown> | undefined> {
    const factory = dagsterBootstrap.factory('direct', { namespace: 'd' });
    const yaml = await factory.toYaml(spec as never);
    const docs = yaml
      .split(/^---$/m)
      .map((doc) => doc.trim())
      .filter(Boolean)
      .map((doc) => load(doc) as Record<string, unknown>);
    const helmRelease = docs.find((doc) => doc?.kind === 'HelmRelease');
    const values = (helmRelease?.spec as { values?: Record<string, unknown> } | undefined)?.values;
    return values?.dagsterDaemon as Record<string, unknown> | undefined;
  }

  // When the daemon loses its DB connection it can hang without exiting; the chart
  // ships no daemon liveness probe, so we add a conservative dagster-canonical one
  // so k8s restarts it.
  it('Apply a conservative default liveness probe when the daemon is enabled and none is supplied', async () => {
    const daemon = await daemonValues({
      name: 'analytics',
      namespace: 'd',
      postgresql: { enabled: true },
    });
    expect(daemon?.livenessProbe).toEqual({
      exec: { command: ['dagster-daemon', 'liveness-check'] },
      initialDelaySeconds: 120,
      periodSeconds: 60,
      timeoutSeconds: 10,
      failureThreshold: 5,
    });
  });

  it('Let a user-supplied daemon livenessProbe override the default', async () => {
    const userProbe = { httpGet: { path: '/healthz', port: 3070 }, periodSeconds: 15 };
    const daemon = await daemonValues({
      name: 'analytics',
      namespace: 'd',
      postgresql: { enabled: true },
      daemon: { livenessProbe: userProbe },
    });
    expect(daemon?.livenessProbe).toEqual(userProbe);
  });

  it('Never inject the default liveness probe when the daemon is disabled', async () => {
    const daemon = await daemonValues({
      name: 'analytics',
      namespace: 'd',
      postgresql: { enabled: true },
      daemon: { enabled: false },
    });
    expect(daemon?.livenessProbe).toBeUndefined();
  });

  // In KRO mode the spec is a proxy, so the default is emitted as a CEL fallback
  // into the chart values: a user-supplied livenessProbe wins per instance, else
  // the default exec probe applies. This keeps the production fix working on the
  // primary (KRO) deploy path, not just direct mode.
  it('Emit the default daemon liveness probe as a CEL fallback in the KRO RGD', () => {
    const yaml = dagsterBootstrap.toYaml();
    expect(yaml).toContain('has(schema.spec.daemon.livenessProbe)');
    expect(yaml).toContain('schema.spec.daemon.livenessProbe :');
    expect(yaml).toContain('dagster-daemon');
    expect(yaml).toContain('liveness-check');
  });
});
