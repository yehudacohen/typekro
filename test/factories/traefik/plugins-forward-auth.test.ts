/**
 * Traefik plugins and the forwardAuth secure pair (no cluster).
 *
 * - `plugins` / `localPlugins` / `abortOnPluginFailure` build options, with
 *   the required archive hash.
 * - `traefikPluginMiddleware` and `traefikSecretValue` (`urn:k8s:secret`).
 * - `traefikForwardAuthSecurePair`: strip the identity headers, then authorize.
 */
import { describe, expect, it } from 'bun:test';

import { makeTraefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import {
  traefikForwardAuthSecurePair,
  traefikPluginMiddleware,
} from '../../../src/factories/traefik/resources/middleware.js';
import type { TraefikLocalPluginDeclaration } from '../../../src/factories/traefik/types.js';
import {
  mapTraefikConfigToHelmValues,
  validateTraefikHelmValues,
} from '../../../src/factories/traefik/utils/helm-values-mapper.js';
import { traefikSecretValue } from '../../../src/factories/traefik/utils/plugins.js';

const HASH = 'a'.repeat(64);
const BOUNCER = {
  moduleName: 'github.com/example/bouncer-plugin',
  version: 'v1.4.2',
  hash: HASH,
};

describe('plugin declarations', () => {
  it('maps registry and local plugins, aborting on a failed load by default', () => {
    const values = mapTraefikConfigToHelmValues(
      { name: 'traefik' },
      {
        plugins: { bouncer: BOUNCER },
        localPlugins: {
          stamp: {
            moduleName: 'example.com/stamp',
            type: 'inlinePlugin',
            source: { '.traefik.yml': 'displayName: stamp\n', 'stamp.go': 'package stamp\n' },
          },
        },
      }
    );

    expect(values.experimental?.plugins).toEqual({ bouncer: BOUNCER });
    expect(values.experimental?.localPlugins).toEqual({
      stamp: {
        moduleName: 'example.com/stamp',
        type: 'inlinePlugin',
        source: { '.traefik.yml': 'displayName: stamp\n', 'stamp.go': 'package stamp\n' },
        mountPath: '/plugins-local/src/example.com/stamp',
      },
    });
    expect(values.experimental?.abortOnPluginFailure).toBe(true);
  });

  it('emits no experimental section when no plugin is declared', () => {
    expect(mapTraefikConfigToHelmValues({ name: 'traefik' })).not.toHaveProperty('experimental');
  });

  it('lets abortOnPluginFailure be turned off explicitly', () => {
    const values = mapTraefikConfigToHelmValues(
      { name: 'traefik' },
      { plugins: { bouncer: BOUNCER }, abortOnPluginFailure: false }
    );
    expect(values.experimental?.abortOnPluginFailure).toBe(false);
  });

  it('refuses an unpinned or malformed plugin', () => {
    const invalid = [
      { bouncer: { ...BOUNCER, hash: '' } },
      { bouncer: { ...BOUNCER, hash: 'A'.repeat(64) } },
      { bouncer: { ...BOUNCER, version: 'latest' } },
      { bouncer: { ...BOUNCER, moduleName: ' ' } },
      { 'bad.name': BOUNCER },
    ];
    for (const plugins of invalid) {
      expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { plugins })).toThrow(
        /Invalid Traefik plugin declaration/
      );
    }
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        {
          plugins: { bouncer: BOUNCER },
          localPlugins: { bouncer: { moduleName: 'x', type: 'localPath', volumeName: 'v' } },
        }
      )
    ).toThrow(/both as a registry and a local plugin/);
  });

  it('puts local-plugin mount paths through the static-configuration check', () => {
    const stamp: TraefikLocalPluginDeclaration = {
      moduleName: 'example.com/stamp',
      type: 'localPath',
      volumeName: 'plugins',
    };
    // The typed mount path is derived under /plugins-local/src, and moduleName
    // can't start with "/" or contain "..", so it never reaches /etc/traefik.
    for (const moduleName of ['/etc/traefik', 'x/../../../etc/traefik', '.']) {
      expect(() =>
        mapTraefikConfigToHelmValues(
          { name: 'traefik' },
          { localPlugins: { stamp: { ...stamp, moduleName } } }
        )
      ).toThrow(/Invalid Traefik plugin declaration/);
    }
    // A raw local plugin kept beside the typed ones is checked in the final values.
    const baseValues = {
      experimental: {
        localPlugins: { legacy: { moduleName: 'legacy', type: 'localPath', mountPath: '/etc' } },
      },
    };
    expect(() =>
      mapTraefikConfigToHelmValues({ name: 'traefik' }, { localPlugins: { stamp }, baseValues })
    ).toThrow(/experimental\.localPlugins\.legacy\.mountPath mounts \/etc/);
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        { localPlugins: { stamp }, baseValues, dangerouslyTrustAnySource: true }
      )
    ).not.toThrow();
    expect(() =>
      mapTraefikConfigToHelmValues({ name: 'traefik' }, { localPlugins: { stamp } })
    ).not.toThrow();
  });

  it('holds local plugin names to what the chart can turn into volume and ConfigMap names', () => {
    const inline = (_name: string, file = 'stamp.go'): TraefikLocalPluginDeclaration => ({
      moduleName: 'example.com/stamp',
      type: 'inlinePlugin',
      source: { [file]: 'package stamp\n' },
    });
    const map = (localPlugins: Record<string, TraefikLocalPluginDeclaration>) => () =>
      mapTraefikConfigToHelmValues({ name: 'traefik' }, { localPlugins });
    // The chart names the volume after the plugin and the ConfigMap
    // `<release>-local-plugin-<name>`; the API server needs DNS-1123 there.
    for (const name of ['Stamp', 'my_plugin', 'a'.repeat(64), '-stamp', 'tmp', 'plugins']) {
      expect(map({ [name]: inline(name) })).toThrow(/Invalid Traefik plugin declaration/);
    }
    for (const name of ['Stamp', 'my_plugin']) {
      expect(
        map({ [name]: { moduleName: 'example.com/stamp', type: 'localPath', volumeName: 'v' } })
      ).toThrow(/DNS-1123 label/);
    }
    const longest = 'p'.repeat(63);
    expect(map({ [longest]: inline(longest) })).not.toThrow();
    // The release part is truncated to 63 characters by the chart.
    expect(`${'r'.repeat(63)}-local-plugin-${longest}`.length).toBeLessThanOrEqual(253);
    // Remote plugin names only become flag keys, so they keep the wider rule.
    expect(() =>
      mapTraefikConfigToHelmValues({ name: 'traefik' }, { plugins: { My_Bouncer: BOUNCER } })
    ).not.toThrow();
  });

  it('refuses an inline plugin named like a volume the raw values add', () => {
    const stamp = (name: string): Record<string, TraefikLocalPluginDeclaration> => ({
      [name]: {
        moduleName: 'example.com/stamp',
        type: 'inlinePlugin',
        source: { 'stamp.go': 'package stamp\n' },
      },
    });
    const baseValues = {
      volumes: [{ name: 'extra.config', mountPath: '/config', type: 'configMap' }],
      persistence: { name: 'state', path: '/state' },
      deployment: { additionalVolumes: [{ name: 'plugin-src', emptyDir: {} }] },
    };
    for (const name of ['extra-config', 'state', 'plugin-src']) {
      expect(() =>
        mapTraefikConfigToHelmValues({ name: 'traefik' }, { localPlugins: stamp(name), baseValues })
      ).toThrow(/volume name the pod already has/);
    }
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        { localPlugins: stamp('stamp'), baseValues }
      )
    ).not.toThrow();
  });

  it('holds inline source file names to the ConfigMap key rule', () => {
    for (const file of ['.', '..', '..x', 'a/b', '']) {
      expect(() =>
        mapTraefikConfigToHelmValues(
          { name: 'traefik' },
          {
            localPlugins: {
              stamp: {
                moduleName: 'example.com/stamp',
                type: 'inlinePlugin',
                source: { [file]: 'package stamp\n', 'go.mod': 'module stamp\n' },
              },
            },
          }
        )
      ).toThrow(/ConfigMap key/);
    }
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        {
          localPlugins: {
            stamp: {
              moduleName: 'example.com/stamp',
              type: 'inlinePlugin',
              source: { '.traefik.yml': 'displayName: stamp\n', 'stamp.go': 'package stamp\n' },
            },
          },
        }
      )
    ).not.toThrow();
  });

  it('refuses plugin fields that would inject YAML into the chart templates', () => {
    // The chart writes these unescaped, e.g.
    // "--experimental.plugins.<name>.moduleName={{ $plugin.moduleName }}", so a
    // quote and newline would add an argument such as an insecure trust flag.
    const injected = 'x"\n          - "--entryPoints.web.forwardedHeaders.insecure=true';
    const invalidPlugins = [
      { bouncer: { ...BOUNCER, moduleName: injected } },
      { bouncer: { ...BOUNCER, version: `v1.0.0${injected}` } },
    ];
    for (const plugins of invalidPlugins) {
      expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { plugins })).toThrow(
        /Invalid Traefik plugin declaration/
      );
    }
    const invalidLocal: Record<string, TraefikLocalPluginDeclaration>[] = [
      { stamp: { moduleName: injected, type: 'localPath', volumeName: 'plugins' } },
      { stamp: { moduleName: 'example.com/stamp', type: 'localPath', volumeName: injected } },
      {
        stamp: {
          moduleName: 'example.com/stamp',
          type: 'localPath',
          volumeName: 'plugins',
          subPath: 'src\n            mountPath: /etc/traefik',
        },
      },
      {
        stamp: {
          moduleName: 'example.com/stamp',
          type: 'localPath',
          volumeName: 'plugins',
          subPath: '../other',
        },
      },
      {
        stamp: {
          moduleName: 'example.com/stamp',
          type: 'inlinePlugin',
          source: { 'stamp.go: |\n---\nkind: Secret': 'package stamp\n' },
        },
      },
    ];
    for (const localPlugins of invalidLocal) {
      expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { localPlugins })).toThrow(
        /Invalid Traefik plugin declaration/
      );
    }
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        {
          plugins: { bouncer: { ...BOUNCER, version: 'v2.0.0-rc.1+build.5' } },
          localPlugins: {
            stamp: {
              moduleName: 'example.com/stamp',
              type: 'localPath',
              volumeName: 'plugins',
              subPath: 'src/stamp',
            },
          },
        }
      )
    ).not.toThrow();
  });

  it('keeps raw-values plugins but warns about any without a hash', () => {
    const values = mapTraefikConfigToHelmValues(
      { name: 'traefik' },
      {
        plugins: { bouncer: BOUNCER },
        baseValues: { experimental: { plugins: { legacy: { moduleName: 'm', version: 'v1' } } } },
      }
    );

    expect(Object.keys(values.experimental?.plugins ?? {}).sort()).toEqual(['bouncer', 'legacy']);
    expect(validateTraefikHelmValues(values).filter((w) => w.includes('no hash'))).toEqual([
      expect.stringContaining('plugin legacy'),
    ]);
  });

  it('reaches the RGD through makeTraefikBootstrap', () => {
    const yaml = makeTraefikBootstrap({
      name: 'traefik-plugins',
      kind: 'TraefikPlugins',
      plugins: { bouncer: BOUNCER },
    }).toYaml();

    expect(yaml).toContain(`hash: ${HASH}`);
    expect(yaml).toContain('abortOnPluginFailure: true');
  });
});

describe('plugin middleware and Secret references', () => {
  it('traefikPluginMiddleware keys the config by plugin name', () => {
    const middleware = traefikPluginMiddleware({
      name: 'bouncer',
      namespace: 'edge',
      plugin: 'bouncer',
      config: { enabled: true, apiKey: traefikSecretValue('bouncer-key', 'api-key') },
    });

    expect(middleware.kind).toBe('Middleware');
    expect(middleware.spec.plugin).toEqual({
      bouncer: { enabled: true, apiKey: 'urn:k8s:secret:bouncer-key:api-key' },
    });
  });

  it('traefikSecretValue refuses parts Traefik would mis-split', () => {
    expect(() => traefikSecretValue('a:b', 'key')).toThrow(/secret name/);
    expect(() => traefikSecretValue('name', '')).toThrow(/key/);
  });
});

describe('alias headers', () => {
  it('deletes headers whose names alias another on both entrypoints by default', () => {
    const values = mapTraefikConfigToHelmValues({ name: 'traefik' });

    expect(values.ports?.web?.http?.aliasHeadersStrategy).toBe('delete');
    expect(values.ports?.websecure?.http?.aliasHeadersStrategy).toBe('delete');
    // The redirect and TLS sit beside it, untouched.
    expect(values.ports?.web?.http?.redirections?.entryPoint?.to).toBe('websecure');
    expect(values.ports?.websecure?.http?.tls?.enabled).toBe(true);
  });

  it('can keep or reject them per entrypoint, with or without the redirect', () => {
    const values = mapTraefikConfigToHelmValues(
      {
        name: 'traefik',
        entrypoints: {
          web: { aliasHeadersStrategy: 'keep' },
          websecure: { aliasHeadersStrategy: 'reject' },
        },
      },
      { redirectWebToWebsecure: false }
    );

    expect(values.ports?.web?.http).toEqual({ aliasHeadersStrategy: 'keep' });
    expect(values.ports?.websecure?.http?.aliasHeadersStrategy).toBe('reject');
  });

  it('defaults to delete in the KRO RGD too', () => {
    const yaml = makeTraefikBootstrap({ name: 'traefik-alias', kind: 'TraefikAlias' }).toYaml();

    expect(yaml).toContain(
      'aliasHeadersStrategy: \'${has(schema.spec.entrypoints) && has(schema.spec.entrypoints.websecure) && has(schema.spec.entrypoints.websecure.aliasHeadersStrategy) && dyn(schema.spec.entrypoints.websecure.aliasHeadersStrategy) != null ? schema.spec.entrypoints.websecure.aliasHeadersStrategy : "delete"}\''
    );
  });
});

describe('traefikForwardAuthSecurePair', () => {
  const config = {
    name: 'orders-authz',
    namespace: 'edge',
    address: 'http://authorizer.edge.svc.cluster.local:8080/authorize',
    authResponseHeaders: ['X-Auth-User', 'X-Auth-Tenant'],
    authRequestHeaders: ['Authorization'],
    id: 'ordersAuthz',
  };

  it('strips the identity headers before forwardAuth and chains the two', () => {
    const pair = traefikForwardAuthSecurePair(config);

    expect(pair.stripIdentityHeaders.metadata.name).toBe('orders-authz-strip-identity');
    expect(pair.stripIdentityHeaders.spec.headers?.customRequestHeaders).toEqual({
      'X-Auth-User': '',
      'X-Auth-Tenant': '',
    });
    expect(pair.forwardAuth.metadata.name).toBe('orders-authz-forward-auth');
    expect(pair.forwardAuth.spec.forwardAuth).toMatchObject({
      address: config.address,
      trustForwardHeader: false,
      authResponseHeaders: ['X-Auth-User', 'X-Auth-Tenant'],
      authRequestHeaders: ['Authorization'],
    });
    expect(pair.chain.metadata.name).toBe('orders-authz');
    expect(pair.chain.spec.chain?.middlewares).toEqual([
      { name: 'orders-authz-strip-identity', namespace: 'edge' },
      { name: 'orders-authz-forward-auth', namespace: 'edge' },
    ]);
  });

  it('refuses to forward a returned identity header to the authorizer', () => {
    expect(() =>
      traefikForwardAuthSecurePair({ ...config, authRequestHeaders: ['x-auth-user'] })
    ).toThrow(/forwards x-auth-user to the authorizer/);
  });
});
