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
  clickhouse: { host: 'clickhouse.clickhouse.svc.cluster.local', username: 'otelcollector', password: 'pw' },
  apiKey: 'test-ingestion-api-key',
} as const;

type Doc = { kind?: string; metadata?: { name?: string }; spec?: Record<string, unknown>; binaryData?: Record<string, string> };

function directDocs(options: Record<string, unknown>, spec: object = SPEC): Doc[] {
  const yaml = makeClickstackBootstrap(options as never)
    .factory('direct', { namespace: 'clickstack' })
    .toYaml(spec as never);
  return (loadAll(yaml) as Doc[]).filter(Boolean);
}

function hyperdxDeploymentValues(docs: Doc[]): Record<string, unknown> {
  const release = docs.find((doc) => doc.kind === 'HelmRelease' && doc.metadata?.name === 'clickstack');
  const values = (release?.spec?.values ?? {}) as { hyperdx?: { deployment?: Record<string, unknown> } };
  return values.hyperdx?.deployment ?? {};
}

const OIDC = { configSecretRef: { name: 'hyperdx-oidc' } };

describe('hyperdxOidc wiring', () => {
  it('ships the plugin ConfigMap, byte-identical to the bundle', () => {
    const docs = directDocs({ hyperdxOidc: OIDC });
    const plugin = docs.find((doc) => doc.kind === 'ConfigMap' && doc.metadata?.name === 'clickstack-hyperdx-oidc-plugin');
    expect(plugin).toBeDefined();
    const bundle = Buffer.from(plugin?.binaryData?.['plugin.js'] ?? '', 'base64');
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(HYPERDX_OIDC_PLUGIN_SHA256);
  });

  it('loads the plugin through NODE_OPTIONS and points it at the mounted configuration', () => {
    const env = hyperdxDeploymentValues(directDocs({ hyperdxOidc: { ...OIDC, reloadSeconds: 30 } })).env;
    expect(env).toEqual([
      { name: 'NODE_OPTIONS', value: '--require=/opt/typekro/hyperdx-oidc/plugin.js' },
      { name: 'TYPEKRO_HDX_OIDC_CONFIG', value: '/etc/typekro/hyperdx-oidc/config.json' },
      { name: 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS', value: '30' },
      { name: 'TYPEKRO_HDX_OIDC_CREATE_TEAM', value: 'true' },
    ]);
  });

  it('stops a first OIDC login from creating the team when initialUser claims the instance', () => {
    const env = hyperdxDeploymentValues(
      directDocs({ hyperdxOidc: OIDC, initialUser: { email: 'ops@example.com' } })
    ).env as { name: string; value: string }[];
    expect(env.find((entry) => entry.name === 'TYPEKRO_HDX_OIDC_CREATE_TEAM')?.value).toBe('false');
  });

  it('mounts the configuration Secret as a directory, never with subPath (hot reload)', () => {
    const deployment = hyperdxDeploymentValues(directDocs({ hyperdxOidc: { configSecretRef: { name: 'sso', key: 'providers.json' } } }));
    expect(deployment.volumes).toContainEqual({
      name: 'typekro-hyperdx-oidc-config',
      secret: { secretName: 'sso', items: [{ key: 'providers.json', path: 'config.json' }] },
    });
    const mounts = deployment.volumeMounts as Record<string, unknown>[];
    expect(mounts.every((mount) => mount.subPath === undefined)).toBe(true);
    expect(mounts).toContainEqual({ name: 'typekro-hyperdx-oidc-config', mountPath: '/etc/typekro/hyperdx-oidc', readOnly: true });
  });

  it('stamps the plugin hash on the pod, so a new plugin build rolls it', () => {
    const annotations = hyperdxDeploymentValues(directDocs({ hyperdxOidc: OIDC })).podAnnotations as Record<string, string>;
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
    expect((deployment.volumeMounts as Record<string, unknown>[])[0]).toEqual({ name: 'certs', mountPath: '/certs' });
    expect(deployment.podAnnotations).toMatchObject({ 'example.com/keep': 'me' });
  });

  it('adds nothing when hyperdxOidc is not configured', () => {
    const docs = directDocs({});
    expect(docs.some((doc) => doc.metadata?.name?.endsWith('-hyperdx-oidc-plugin'))).toBe(false);
    expect(hyperdxDeploymentValues(docs).env).toBeUndefined();
  });

  it('makes the HelmRelease wait for the plugin ConfigMap in KRO mode', () => {
    const yaml = makeClickstackBootstrap({ hyperdxOidc: OIDC, name: 'cs-oidc-kro', kind: 'CsOidcKro' }).toYaml();
    expect(yaml).toContain('id: clickstackHyperdxOidcPlugin');
    expect(yaml).toContain('${string(schema.spec.name)}-hyperdx-oidc-plugin');
  });
});

describe('hyperdxOidc validation', () => {
  it('refuses invalid Secret coordinates and reload intervals', () => {
    expect(() => resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'Bad_Name' } })).toThrow(/not a valid Secret name/);
    expect(() => resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'ok', key: 'a/b' } })).toThrow(/not a valid Secret key/);
    expect(() => resolveClickStackHyperdxOidc('t', { configSecretRef: { name: 'ok' }, reloadSeconds: 0 })).toThrow(/reloadSeconds/);
  });

  it('refuses caller values that already set the env or volumes it owns', () => {
    const oidc = resolveClickStackHyperdxOidc('t', OIDC);
    if (oidc === undefined) throw new Error('unreachable');
    expect(() =>
      applyHyperdxOidcValues('t', { hyperdx: { deployment: { env: [{ name: 'NODE_OPTIONS', value: '--x' }] } } }, oidc, 'r')
    ).toThrow(/already sets NODE_OPTIONS/);
    expect(() =>
      applyHyperdxOidcValues('t', { hyperdx: { deployment: { volumes: [{ name: 'typekro-hyperdx-oidc-plugin' }] } } }, oidc, 'r')
    ).toThrow(/already uses volume name/);
    expect(() => applyHyperdxOidcValues('t', { hyperdx: { deployment: { env: 'nope' } } }, oidc, 'r')).toThrow(/must be a list/);
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
      directDocs({ hyperdxOidc: { ...OIDC, allowUnvalidatedChartVersion: true } }, { ...SPEC, version: '4.0.0' })
    ).not.toThrow();
  });

  it('narrows spec.version on the generated CRD in KRO mode', () => {
    const yaml = makeClickstackBootstrap({ hyperdxOidc: OIDC, name: 'cs-oidc-version', kind: 'CsOidcVersion' }).toYaml();
    expect(yaml).toContain('version: string | validation="self in [\\"3.2.0\\"]"');
  });

  it('names the ConfigMap from the release and carries only the bundle', () => {
    expect(hyperdxOidcPluginConfigMapName('telemetry')).toBe('telemetry-hyperdx-oidc-plugin');
    expect(Object.keys(hyperdxOidcPluginConfigMapData().binaryData)).toEqual(['plugin.js']);
  });
});
