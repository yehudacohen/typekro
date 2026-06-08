import { describe, expect, it } from 'bun:test';
import { dagsterBootstrap } from '../../../src/factories/dagster/index.js';
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
    expect(yaml).toContain('dagsterHelmRepository');
    expect(yaml).toContain('dagsterHelmRelease');
    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('https://dagster-io.github.io/helm');
    expect(yaml).toContain('chart: dagster');
    expect(yaml).toContain('1.13.8');
    expect(yaml).toContain('ready: ${dagsterHelmRelease.status.conditions');
    expect(yaml).toContain('phase: "${dagsterHelmRelease.status.conditions');
    expect(yaml).not.toContain('kind: Deployment');
    expect(yaml).not.toContain('kind: Pod');
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
    expect(yaml).toContain('schema.spec.global.dagsterInstanceConfigMap');
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
