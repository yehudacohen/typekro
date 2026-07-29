import { describe, expect, it } from 'bun:test';
import { hatchetInstallation } from '../../../src/factories/hatchet/compositions/hatchet-installation.js';
import {
  DEFAULT_HATCHET_CHART_VERSION,
  DEFAULT_HATCHET_SERVER_VERSION,
} from '../../../src/factories/hatchet/resources/helm.js';

function documents(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((document) => document.trim())
    .filter(Boolean);
}

function kind(document: string): string | undefined {
  return document.match(/^kind: (.+)$/m)?.[1];
}

const requiredConfig = {
  name: 'hatchet',
  namespace: 'workflow-system',
  database: {
    connectionSecret: { name: 'hatchet-db-app' },
  },
  adminCredentialsSecret: {
    name: 'hatchet-admin',
  },
} as const;

describe('Hatchet installation', () => {
  it('emits the official chart with external state and Secret-backed values', () => {
    const customValues = {
      api: { resources: { requests: { cpu: '250m' } } },
      postgres: { enabled: true },
      rabbitmq: { enabled: true },
    };
    const yaml = hatchetInstallation.factory('direct', { namespace: 'typekro-system' }).toYaml({
      ...requiredConfig,
      replicas: { api: 2, engine: 3, frontend: 2 },
      values: customValues,
    });
    const docs = documents(yaml);

    expect(docs.map(kind)).toContain('Namespace');
    expect(docs.map(kind)).toContain('HelmRepository');
    expect(docs.map(kind)).toContain('HelmRelease');
    expect(docs.map(kind)).not.toContain('Secret');
    expect(yaml).toContain('url: https://hatchet-dev.github.io/hatchet-charts');
    expect(yaml).toContain('chart: hatchet-stack');
    expect(yaml).toContain(`version: ${DEFAULT_HATCHET_CHART_VERSION}`);
    expect(yaml).toContain(`tag: ${DEFAULT_HATCHET_SERVER_VERSION}`);
    expect(yaml).toContain('name: hatchet-db-app');
    expect(yaml).toContain('name: hatchet-admin');
    expect(yaml).toContain('envFrom:');
    expect(yaml).toContain('name: hatchet-shared-config');
    expect(yaml).not.toContain('valuesFrom:');
    expect(yaml).not.toContain('literal: true');
    expect(yaml).toMatch(/postgres:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/rabbitmq:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/api:\s*\n(?:.*\n)*?\s+replicaCount: 2/);
    expect(yaml).toMatch(/engine:\s*\n(?:.*\n)*?\s+replicaCount: 3/);
    expect(yaml).toContain('cpu: 250m');
    expect(yaml).toMatch(/workerTokenJob:\s*\n\s+enabled: true/);
    expect(yaml).toContain('remediateLastFailure: false');
    expect(yaml).not.toContain('rollback');
    expect(yaml).not.toContain('__typekroValuesMerge');
    expect(yaml).toContain('name: workflow-system-hatchet-hatchet');
    expect(customValues).toEqual({
      api: { resources: { requests: { cpu: '250m' } } },
      postgres: { enabled: true },
      rabbitmq: { enabled: true },
    });
  });

  it('supports externally owned workload and repository namespaces', () => {
    const yaml = hatchetInstallation.factory('direct', { namespace: 'typekro-system' }).toYaml({
      ...requiredConfig,
      namespaceOwnership: 'external',
      repositoryNamespace: 'flux-system',
      repositoryNamespaceOwnership: 'external',
    });

    expect(documents(yaml).map(kind)).not.toContain('Namespace');
    expect(yaml).toContain('namespace: workflow-system');
    expect(yaml).toContain('namespace: flux-system');
  });

  it('gives same-named installations in different namespaces isolated repositories', () => {
    const factory = hatchetInstallation.factory('direct', {
      namespace: 'typekro-system',
    });
    const first = factory.toYaml({
      ...requiredConfig,
      namespace: 'team-a',
      repositoryNamespace: 'flux-system',
      repositoryNamespaceOwnership: 'external',
    });
    const second = factory.toYaml({
      ...requiredConfig,
      namespace: 'team-b',
      repositoryNamespace: 'flux-system',
      repositoryNamespaceOwnership: 'external',
    });

    expect(first).toContain('name: team-a-hatchet-hatchet');
    expect(second).toContain('name: team-b-hatchet-hatchet');
    expect(first).not.toContain('name: team-b-hatchet-hatchet');
    expect(second).not.toContain('name: team-a-hatchet-hatchet');
  });

  it('serializes the complete contract in KRO mode without embedding credentials', () => {
    const factory = hatchetInstallation.factory('kro', {
      namespace: 'typekro-system',
    });
    const rgd = factory.toYaml();

    expect(rgd).toContain('kind: ResourceGraphDefinition');
    expect(rgd).toContain('kind: HelmRelease');
    expect(rgd).toContain('kind: HelmRepository');
    expect(rgd).toContain('externalRef:');
    expect(rgd).toContain('kind: Secret');
    expect(rgd).toContain('${schema.spec.database.connectionSecret.name}');
    expect(rgd).toContain('${schema.spec.adminCredentialsSecret.name}');
    expect(rgd).toContain('envFrom');
    expect(rgd).not.toContain('valuesFrom:');
    expect(rgd).not.toContain('literal: true');
    expect(rgd).toContain('schema.spec.replicas.api');
    expect(rgd).toContain('schema.spec.replicas.engine');
    expect(rgd).toContain('postgres');
    expect(rgd).toContain('rabbitmq');
    expect(rgd).toContain('"enabled": false');
    expect(rgd).toContain(
      'chartVersion: ${hatchetMetadata.metadata.annotations["typekro.dev/chart-version"]}'
    );
    expect(rgd).toContain(
      'workerTokenSecret: ${hatchetMetadata.metadata.annotations["typekro.dev/worker-token-secret"]}'
    );
    expect(rgd).toContain(
      'configurationSecret: ${hatchetMetadata.metadata.annotations["typekro.dev/configuration-secret"]}'
    );
    expect(rgd).toContain(
      'string(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system") + "-" + string(schema.spec.name) + "-hatchet"'
    );
    expect(rgd).toContain('hatchet-config');
    expect(rgd).toContain('hatchet-client-config');
    expect(rgd).toContain('name: string | validation="size(self) > 0"');
    expect(rgd).not.toContain('kind: Namespace');
    expect(rgd).not.toContain('admin@example');

    const instance = factory.toYaml(requiredConfig);
    expect(instance).toContain('kind: HatchetInstallation');
    expect(instance).toContain('name: hatchet');
    expect(instance).toContain('name: hatchet-db-app');
    expect(instance).toContain('name: hatchet-admin');
  });

  it('rejects empty direct-mode Secret references', () => {
    const factory = hatchetInstallation.factory('direct', {
      namespace: 'typekro-system',
    });

    expect(() =>
      factory.toYaml({
        ...requiredConfig,
        database: { connectionSecret: { name: '' } },
      })
    ).toThrow();
    expect(() =>
      factory.toYaml({
        ...requiredConfig,
        adminCredentialsSecret: { name: '' },
      })
    ).toThrow();
  });

  it('reports upstream fixed recovery Secret names for non-default release names', () => {
    const yaml = hatchetInstallation.factory('direct', {
      namespace: 'typekro-system',
    }).toYaml({
      ...requiredConfig,
      name: 'workflows',
    });

    expect(yaml).toContain('typekro.dev/configuration-secret: hatchet-config');
    expect(yaml).toContain('typekro.dev/worker-token-secret: hatchet-client-config');
    expect(yaml).not.toContain('workflows-config');
    expect(yaml).not.toContain('workflows-client-config');
    expect(yaml).toContain('name: workflow-system-workflows-hatchet');
  });

  it('does not advertise a worker-token Secret when the chart job is disabled', () => {
    const yaml = hatchetInstallation.factory('direct', {
      namespace: 'typekro-system',
    }).toYaml({
      ...requiredConfig,
      name: 'workflows',
      workerTokenJob: false,
    });

    expect(yaml).toMatch(/typekro\.dev\/worker-token-secret:\s*['"]?['"]?\s*$/m);
    expect(yaml).toMatch(/workerTokenJob:\s*\n\s+enabled: false/);
  });
});
