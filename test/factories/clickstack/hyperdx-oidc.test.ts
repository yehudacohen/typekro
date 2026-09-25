/**
 * `makeClickstackBootstrap({ hyperdxOidc })` — wiring the HyperDX OIDC plugin.
 *
 * What must hold, whatever the caller's own chart values: the plugin ships as
 * a ConfigMap the HelmRelease waits on, it is loaded through `NODE_OPTIONS`,
 * the configuration Secret is mounted WITHOUT subPath (so hot reload works),
 * a plugin change rolls the pod, and none of the caller's own lists are lost.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';
import { makeClickstackBootstrap } from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import {
  applyHyperdxOidcValues,
  HYPERDX_OIDC_PLUGIN_HASH_ANNOTATION,
  HYPERDX_OIDC_PLUGIN_SHA256,
  hyperdxOidcPluginConfigMapData,
  hyperdxOidcPluginConfigMapName,
  resolveClickStackHyperdxOidc,
} from '../../../src/factories/clickstack/hyperdx-oidc/index.js';

const SPEC = {
  name: 'clickstack',
  namespace: 'clickstack',
  clickhouse: {
    host: 'clickhouse.clickhouse.svc.cluster.local',
    username: 'otelcollector',
    password: 'pw',
  },
  apiKey: 'test-ingestion-api-key',
} as const;

type Doc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
  binaryData?: Record<string, string>;
};

function directDocs(options: Record<string, unknown>, spec: object = SPEC): Doc[] {
  const yaml = makeClickstackBootstrap(options as never)
    .factory('direct', { namespace: 'clickstack' })
    .toYaml(spec as never);
  return (loadAll(yaml) as Doc[]).filter(Boolean);
}

function hyperdxDeploymentValues(docs: Doc[]): Record<string, unknown> {
  const release = docs.find(
    (doc) => doc.kind === 'HelmRelease' && doc.metadata?.name === 'clickstack'
  );
  const values = (release?.spec?.values ?? {}) as {
    hyperdx?: { deployment?: Record<string, unknown> };
  };
  return values.hyperdx?.deployment ?? {};
}

const OIDC = { configSecretRef: { name: 'hyperdx-oidc' } };

describe('hyperdxOidc wiring', () => {
  it('ships the plugin ConfigMap, byte-identical to the bundle', () => {
    const docs = directDocs({ hyperdxOidc: OIDC });
    const plugin = docs.find(
      (doc) => doc.kind === 'ConfigMap' && doc.metadata?.name === 'clickstack-hyperdx-oidc-plugin'
    );
    expect(plugin).toBeDefined();
    const bundle = Buffer.from(plugin?.binaryData?.['plugin.js'] ?? '', 'base64');
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(HYPERDX_OIDC_PLUGIN_SHA256);
  });

  it('loads the plugin through NODE_OPTIONS and points it at the mounted configuration', () => {
    const env = hyperdxDeploymentValues(
      directDocs({ hyperdxOidc: { ...OIDC, reloadSeconds: 30 } })
    ).env;
    expect(env).toEqual([
      { name: 'NODE_OPTIONS', value: '--require=/opt/typekro/hyperdx-oidc/plugin.js' },
      { name: 'TYPEKRO_HDX_OIDC_CONFIG', value: '/etc/typekro/hyperdx-oidc/config.json' },
      { name: 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS', value: '30' },
      { name: 'TYPEKRO_HDX_OIDC_CREATE_TEAM', value: 'false' },
    ]);
  });

  it('passes passwordLoginPath to the plugin only when set', () => {
    const env = hyperdxDeploymentValues(
      directDocs({ hyperdxOidc: { ...OIDC, passwordLoginPath: '/login?password' } })
    ).env as { name: string; value: string }[];
    expect(env.find((entry) => entry.name === 'TYPEKRO_HDX_OIDC_PASSWORD_LOGIN_PATH')?.value).toBe(
      '/login?password'
    );
    const defaults = hyperdxDeploymentValues(directDocs({ hyperdxOidc: OIDC })).env as {
      name: string;
    }[];
    expect(defaults.some((entry) => entry.name === 'TYPEKRO_HDX_OIDC_PASSWORD_LOGIN_PATH')).toBe(
      false
    );
  });

  it('stops a first OIDC login from creating the team on both paths, since the bootstrap owns it', () => {
    // Without initialUser the CronJob creates the Team itself; a first OIDC
    // login that created one first would leave two.
    for (const options of [
      { hyperdxOidc: OIDC },
      { hyperdxOidc: OIDC, initialUser: { email: 'ops@example.com' } },
    ]) {
      const env = hyperdxDeploymentValues(directDocs(options)).env as {
        name: string;
        value: string;
      }[];
      expect(env.find((entry) => entry.name === 'TYPEKRO_HDX_OIDC_CREATE_TEAM')?.value).toBe(
        'false'
      );
    }
  });

  type Env = Array<{ name: string; value?: string; valueFrom?: unknown }>;
  type SecretVolume = {
    name: string;
    secret?: {
      secretName: string;
      optional?: boolean;
      items?: Array<{ key: string; path: string }>;
    };
  };
  type Mount = { name: string; mountPath: string; readOnly?: boolean; subPath?: string };

  /** Every (Secret, key) the initialUser CronJob's containers read through a secretKeyRef. */
  function cronJobSecretRefs(docs: Doc[]): Array<{ name: string; key: string }> {
    const cronJob = docs.find(
      (doc) => doc.kind === 'CronJob' && doc.metadata?.name === 'clickstack-team-bootstrap'
    ) as {
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: Array<{
                  env: Array<{ valueFrom?: { secretKeyRef?: { name: string; key: string } } }>;
                }>;
              };
            };
          };
        };
      };
    };
    return cronJob.spec.jobTemplate.spec.template.spec.containers
      .flatMap((container) => container.env)
      .flatMap((entry) =>
        entry.valueFrom?.secretKeyRef
          ? [{ name: entry.valueFrom.secretKeyRef.name, key: entry.valueFrom.secretKeyRef.key }]
          : []
      );
  }

  it("projects the CronJob's own password Secret key into HyperDX as a file, with the initial user's email", () => {
    const docs = directDocs({ hyperdxOidc: OIDC, initialUser: { email: ' ops@example.com ' } });
    const deployment = hyperdxDeploymentValues(docs);
    const env = deployment.env as Env;
    expect(env.filter((entry) => entry.name.startsWith('TYPEKRO_HDX_OIDC_BOOTSTRAP'))).toEqual([
      { name: 'TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL', value: 'ops@example.com' },
      {
        name: 'TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE',
        value: '/etc/typekro/hyperdx-bootstrap/password',
      },
    ]);
    // Never a Secret-backed env var: that would be frozen for the pod's lifetime.
    expect(env.some((entry) => entry.valueFrom !== undefined)).toBe(false);

    const volume = (deployment.volumes as SecretVolume[]).find(
      (entry) => entry.name === 'typekro-hyperdx-oidc-bootstrap'
    );
    expect(volume).toEqual({
      name: 'typekro-hyperdx-oidc-bootstrap',
      secret: {
        secretName: 'clickstack-secret',
        optional: true,
        items: [{ key: 'HYPERDX_INITIAL_USER_PASSWORD', path: 'password' }],
      },
    });
    // A whole-directory mount, never subPath, so the kubelet refreshes the file.
    expect(
      (deployment.volumeMounts as Mount[]).filter(
        (mount) => mount.name === 'typekro-hyperdx-oidc-bootstrap'
      )
    ).toEqual([
      {
        name: 'typekro-hyperdx-oidc-bootstrap',
        mountPath: '/etc/typekro/hyperdx-bootstrap',
        readOnly: true,
      },
    ]);
    // The same Secret and key the initialUser CronJob reads.
    expect(cronJobSecretRefs(docs)).toContainEqual({
      name: volume?.secret?.secretName as string,
      key: volume?.secret?.items?.[0]?.key as string,
    });
  });

  it('projects an external password Secret when initialUser.passwordSecretRef is set', () => {
    const docs = directDocs({
      hyperdxOidc: OIDC,
      initialUser: {
        email: 'ops@example.com',
        passwordSecretRef: { name: 'hyperdx-bootstrap', key: 'initial.password' },
      },
    });
    const volume = (hyperdxDeploymentValues(docs).volumes as SecretVolume[]).find(
      (entry) => entry.name === 'typekro-hyperdx-oidc-bootstrap'
    );
    expect(volume?.secret).toEqual({
      secretName: 'hyperdx-bootstrap',
      optional: true,
      items: [{ key: 'initial.password', path: 'password' }],
    });
    expect(cronJobSecretRefs(docs)).toContainEqual({
      name: 'hyperdx-bootstrap',
      key: 'initial.password',
    });
  });

  it('adds no bootstrap env, volume or mount without initialUser', () => {
    const deployment = hyperdxDeploymentValues(directDocs({ hyperdxOidc: OIDC }));
    expect(
      (deployment.env as Env).some((entry) => entry.name.startsWith('TYPEKRO_HDX_OIDC_BOOTSTRAP'))
    ).toBe(false);
    expect((deployment.volumes as SecretVolume[]).map((entry) => entry.name)).not.toContain(
      'typekro-hyperdx-oidc-bootstrap'
    );
    expect((deployment.volumeMounts as Mount[]).map((entry) => entry.name)).not.toContain(
      'typekro-hyperdx-oidc-bootstrap'
    );
  });

  it('mounts the configuration Secret as a directory, never with subPath (hot reload)', () => {
    const deployment = hyperdxDeploymentValues(
      directDocs({ hyperdxOidc: { configSecretRef: { name: 'sso', key: 'providers.json' } } })
    );
    expect(deployment.volumes).toContainEqual({
      name: 'typekro-hyperdx-oidc-config',
      secret: { secretName: 'sso', items: [{ key: 'providers.json', path: 'config.json' }] },
    });
    const mounts = deployment.volumeMounts as Record<string, unknown>[];
    expect(mounts.every((mount) => mount.subPath === undefined)).toBe(true);
    expect(mounts).toContainEqual({
      name: 'typekro-hyperdx-oidc-config',
      mountPath: '/etc/typekro/hyperdx-oidc',
      readOnly: true,
    });
  });

  it('stamps the plugin hash on the pod, so a new plugin build rolls it', () => {
    const annotations = hyperdxDeploymentValues(directDocs({ hyperdxOidc: OIDC }))
      .podAnnotations as Record<string, string>;
    expect(annotations[HYPERDX_OIDC_PLUGIN_HASH_ANNOTATION]).toBe(HYPERDX_OIDC_PLUGIN_SHA256);
  });

  it("appends to the caller's own env, volumes, mounts and annotations instead of replacing them", () => {
    const deployment = hyperdxDeploymentValues(
      directDocs({
        hyperdxOidc: OIDC,
        values: {
          hyperdx: {
            deployment: {
              env: [{ name: 'EXTRA', value: '1' }],
              volumes: [{ name: 'certs', emptyDir: {} }],
              volumeMounts: [{ name: 'certs', mountPath: '/certs' }],
              podAnnotations: { 'example.com/keep': 'me' },
            },
          },
        },
      })
    );
    expect((deployment.env as { name: string }[]).map((entry) => entry.name)).toEqual([
      'EXTRA',
      'NODE_OPTIONS',
      'TYPEKRO_HDX_OIDC_CONFIG',
      'TYPEKRO_HDX_OIDC_RELOAD_SECONDS',
      'TYPEKRO_HDX_OIDC_CREATE_TEAM',
    ]);
    expect((deployment.volumes as { name: string }[]).map((volume) => volume.name)).toEqual([
      'certs',
      'typekro-hyperdx-oidc-plugin',
      'typekro-hyperdx-oidc-config',
    ]);
    expect((deployment.volumeMounts as Record<string, unknown>[])[0]).toEqual({
      name: 'certs',
      mountPath: '/certs',
    });
    expect(deployment.podAnnotations).toMatchObject({ 'example.com/keep': 'me' });
  });

  it('adds nothing when hyperdxOidc is not configured', () => {
    const docs = directDocs({});
    expect(docs.some((doc) => doc.metadata?.name?.endsWith('-hyperdx-oidc-plugin'))).toBe(false);
    expect(hyperdxDeploymentValues(docs).env).toBeUndefined();
  });

  it('makes the HelmRelease wait for the plugin ConfigMap in KRO mode', () => {
    const yaml = makeClickstackBootstrap({
      hyperdxOidc: OIDC,
      name: 'cs-oidc-kro',
      kind: 'CsOidcKro',
    }).toYaml();
    expect(yaml).toContain('id: clickstackHyperdxOidcPlugin');
    expect(yaml).toContain('${string(schema.spec.name)}-hyperdx-oidc-plugin');
  });
});

describe('hyperdxOidc validation', () => {
  it('refuses invalid Secret coordinates and reload intervals', () => {
    expect(() =>
      resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'Bad_Name' } })
    ).toThrow(/not a valid Secret name/);
    expect(() =>
      resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'ok', key: 'a/b' } })
    ).toThrow(/not a valid Secret key/);
    expect(() =>
      resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'ok' }, reloadSeconds: 0 })
    ).toThrow(/reloadSeconds/);
  });

  it("refuses a passwordLoginPath that could leave HyperDX's origin", () => {
    for (const passwordLoginPath of [
      'login',
      '//evil.example/login',
      'https://evil.example/',
      '/a\\b',
      '/a b',
      '/a\nb',
      '',
    ]) {
      expect(() => resolveClickStackHyperdxOidc('t', { ...OIDC, passwordLoginPath })).toThrow(
        /passwordLoginPath/
      );
    }
    expect(
      resolveClickStackHyperdxOidc('t', { ...OIDC, passwordLoginPath: '/login?password' })
        ?.passwordLoginPath
    ).toBe('/login?password');
  });

  it('refuses caller values that already set the env or volumes it owns', () => {
    const oidc = resolveClickStackHyperdxOidc('t', OIDC);
    if (oidc === undefined) throw new Error('unreachable');
    expect(() =>
      applyHyperdxOidcValues(
        't',
        { hyperdx: { deployment: { env: [{ name: 'NODE_OPTIONS', value: '--x' }] } } },
        oidc,
        'r'
      )
    ).toThrow(/already sets NODE_OPTIONS/);
    expect(() =>
      applyHyperdxOidcValues(
        't',
        { hyperdx: { deployment: { volumes: [{ name: 'typekro-hyperdx-oidc-plugin' }] } } },
        oidc,
        'r'
      )
    ).toThrow(/already uses volume name/);
    expect(() =>
      applyHyperdxOidcValues('t', { hyperdx: { deployment: { env: 'nope' } } }, oidc, 'r')
    ).toThrow(/must be a list/);
    expect(() =>
      applyHyperdxOidcValues(
        't',
        {
          hyperdx: {
            deployment: {
              env: [{ name: 'TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE', value: '/x' }],
            },
          },
        },
        oidc,
        'r'
      )
    ).toThrow(/TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE, which hyperdxOidc owns/);
    // The bootstrap password volume's name is owned too, as a volume and as a mount.
    const initialUser = {
      email: 'ops@example.com',
      passwordSecretName: 's',
      passwordSecretKey: 'k',
    };
    expect(() =>
      applyHyperdxOidcValues(
        't',
        {
          hyperdx: {
            deployment: { volumes: [{ name: 'typekro-hyperdx-oidc-bootstrap', emptyDir: {} }] },
          },
        },
        oidc,
        'r',
        initialUser
      )
    ).toThrow(/already uses volume name\(s\) typekro-hyperdx-oidc-bootstrap/);
    expect(() =>
      applyHyperdxOidcValues(
        't',
        {
          hyperdx: {
            deployment: {
              volumeMounts: [{ name: 'typekro-hyperdx-oidc-bootstrap', mountPath: '/x' }],
            },
          },
        },
        oidc,
        'r'
      )
    ).toThrow(/already uses volume name\(s\) typekro-hyperdx-oidc-bootstrap/);
  });

  it("does not mutate the caller's values", () => {
    const oidc = resolveClickStackHyperdxOidc('t', OIDC);
    if (oidc === undefined) throw new Error('unreachable');
    const values = { hyperdx: { deployment: { env: [{ name: 'EXTRA', value: '1' }] } } };
    applyHyperdxOidcValues('t', values, oidc, 'r');
    expect(values.hyperdx.deployment.env).toEqual([{ name: 'EXTRA', value: '1' }]);
  });

  it('refuses an unaudited chart version in direct mode unless opted out', () => {
    expect(() => directDocs({ hyperdxOidc: OIDC }, { ...SPEC, version: '4.0.0' })).toThrow(
      /hyperdxOidc is audited only against chart version/
    );
    expect(() =>
      directDocs(
        { hyperdxOidc: { ...OIDC, allowUnvalidatedChartVersion: true } },
        { ...SPEC, version: '4.0.0' }
      )
    ).not.toThrow();
  });

  it('narrows spec.version on the generated CRD in KRO mode', () => {
    const yaml = makeClickstackBootstrap({
      hyperdxOidc: OIDC,
      name: 'cs-oidc-version',
      kind: 'CsOidcVersion',
    }).toYaml();
    expect(yaml).toContain('version: string | validation="self in [\\"3.2.0\\"]"');
  });

  it('names the ConfigMap from the release and carries only the bundle', () => {
    expect(hyperdxOidcPluginConfigMapName('telemetry')).toBe('telemetry-hyperdx-oidc-plugin');
    expect(Object.keys(hyperdxOidcPluginConfigMapData().binaryData)).toEqual(['plugin.js']);
  });
});
