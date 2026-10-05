/**
 * Traefik side of CrowdSec: the plugin declaration, the bouncer Middleware
 * spec and its fail-open / fail-closed mapping, and the export surface.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import * as crowdsec from '../../../src/factories/crowdsec/index.js';
import {
  CROWDSEC_BOUNCER_PLUGIN_MODULE,
  crowdsecBouncerMiddleware,
  crowdsecSecretUrn,
  crowdsecTraefikPlugin,
  DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH,
} from '../../../src/factories/crowdsec/index.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import { assertCrowdsecBootstrapOptions } from '../../../src/factories/crowdsec/utils/helm-values-mapper.js';
import * as factories from '../../../src/factories/index.js';
import { traefikMiddleware } from '../../../src/factories/traefik/resources/middleware.js';

const BASE = {
  lapiHost: 'crowdsec-service.crowdsec.svc.cluster.local:8080',
  apiKeySecret: { name: 'crowdsec-bouncer', key: 'api-key' },
};

describe('crowdsecTraefikPlugin', () => {
  it('declares the pinned plugin with its archive hash', () => {
    expect(crowdsecTraefikPlugin()).toEqual({
      moduleName: CROWDSEC_BOUNCER_PLUGIN_MODULE,
      version: 'v1.7.1',
      hash: DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH,
    });
  });

  it('requires a hash for any other version', () => {
    expect(() => crowdsecTraefikPlugin({ version: 'v1.7.2' })).toThrow(/needs hash/);
    expect(() => crowdsecTraefikPlugin({ version: 'v1.7.2', hash: 'ABC' })).toThrow(/needs hash/);
    expect(crowdsecTraefikPlugin({ version: 'v1.7.2', hash: 'a'.repeat(64) }).version).toBe(
      'v1.7.2'
    );
  });

  it('refuses floating versions', () => {
    expect(() => crowdsecTraefikPlugin({ version: 'latest', hash: 'a'.repeat(64) })).toThrow(
      /exact release/
    );
  });
});

describe('crowdsecBouncerMiddleware', () => {
  it('runs stream mode against LAPI with the key from a secret, failing open', () => {
    expect(crowdsecBouncerMiddleware(BASE)).toEqual({
      plugin: {
        crowdsec: {
          enabled: true,
          logLevel: 'INFO',
          crowdsecMode: 'stream',
          crowdsecLapiScheme: 'http',
          crowdsecLapiHost: BASE.lapiHost,
          crowdsecLapiKey: 'urn:k8s:secret:crowdsec-bouncer:api-key',
          updateIntervalSeconds: 15,
          updateMaxFailure: -1,
          streamStartupBlock: true,
          crowdsecAppsecEnabled: false,
        },
      },
    });
  });

  it('never configures a captcha provider', () => {
    const config = crowdsecBouncerMiddleware({ ...BASE, appsecHost: 'a:7422' }).plugin.crowdsec;
    expect(Object.keys(config ?? {}).some((key) => key.toLowerCase().includes('captcha'))).toBe(
      false
    );
  });

  it('lets traffic through an unreachable AppSec when failing open', () => {
    const config = crowdsecBouncerMiddleware({
      ...BASE,
      appsecHost: 'crowdsec-appsec-service.crowdsec.svc.cluster.local:7422',
      appsecBodyLimit: 1_048_576,
    }).plugin.crowdsec;
    expect(config).toMatchObject({
      crowdsecAppsecEnabled: true,
      crowdsecAppsecHost: 'crowdsec-appsec-service.crowdsec.svc.cluster.local:7422',
      crowdsecAppsecUnreachableBlock: false,
      crowdsecAppsecFailureBlock: false,
      crowdsecAppsecUnreadableBodyBlock: false,
      crowdsecAppsecBodyLimit: 1_048_576,
    });
  });

  it('blocks after four failed pulls with failOpen: false', () => {
    const config = crowdsecBouncerMiddleware({ ...BASE, appsecHost: 'a:7422', failOpen: false })
      .plugin.crowdsec;
    expect(config).toMatchObject({
      updateMaxFailure: 4,
      crowdsecAppsecUnreachableBlock: true,
      crowdsecAppsecFailureBlock: true,
      crowdsecAppsecUnreadableBodyBlock: true,
    });
    expect(
      crowdsecBouncerMiddleware({ ...BASE, failOpen: false, failClosedAfter: 0 }).plugin.crowdsec
        ?.updateMaxFailure
    ).toBe(0);
    expect(() =>
      crowdsecBouncerMiddleware({ ...BASE, failOpen: false, failClosedAfter: -1 })
    ).toThrow('failClosedAfter must be an integer of at least 0');
  });

  it('reads the key from a file instead of a Secret URN', () => {
    const config = crowdsecBouncerMiddleware({
      lapiHost: BASE.lapiHost,
      apiKeyFile: '/etc/crowdsec-bouncer/api-key',
    }).plugin.crowdsec;
    expect(config?.crowdsecLapiKeyFile).toBe('/etc/crowdsec-bouncer/api-key');
    expect(config?.crowdsecLapiKey).toBeUndefined();
    expect(() => crowdsecBouncerMiddleware({ lapiHost: BASE.lapiHost })).toThrow(/exactly one/);
    expect(() =>
      crowdsecBouncerMiddleware({ lapiHost: BASE.lapiHost, apiKeyFile: '/keys/${a}' })
    ).toThrow(/parse as CEL/);
    expect(() =>
      crowdsecBouncerMiddleware({ ...BASE, apiKeyFile: '/etc/crowdsec-bouncer/api-key' })
    ).toThrow(/exactly one/);
  });

  it('honours the plugin name and trusted proxies', () => {
    const spec = crowdsecBouncerMiddleware({
      ...BASE,
      pluginName: 'bouncer',
      forwardedHeadersTrustedIps: ['10.0.0.0/8'],
      clientTrustedIps: ['192.0.2.1'],
    });
    expect(Object.keys(spec.plugin)).toEqual(['bouncer']);
    expect(spec.plugin.bouncer).toMatchObject({
      forwardedHeadersTrustedIps: ['10.0.0.0/8'],
      clientTrustedIps: ['192.0.2.1'],
    });
  });

  it('is a valid Traefik Middleware spec', () => {
    const middleware = traefikMiddleware({
      name: 'crowdsec',
      namespace: 'traefik',
      spec: crowdsecBouncerMiddleware(BASE),
      id: 'crowdsec',
    });
    expect(middleware.kind).toBe('Middleware');
    expect(Object.keys(middleware.spec)).toEqual(['plugin']);
  });

  it('refuses secret refs Traefik cannot split', () => {
    expect(() => crowdsecSecretUrn({ name: 'a:b', key: 'k' })).toThrow(/may not contain/);
  });

  it('refuses an empty or blank secret name or key', () => {
    expect(() => crowdsecSecretUrn({ name: '', key: '' })).toThrow('Secret name must not be empty');
    expect(() => crowdsecSecretUrn({ name: '  ', key: 'k' })).toThrow(
      'Secret name must not be empty'
    );
    expect(() => crowdsecSecretUrn({ name: 's', key: '' })).toThrow('Secret key must not be empty');
    expect(() => crowdsecSecretUrn({ name: 's', key: '\t' })).toThrow(
      'Secret key must not be empty'
    );
    expect(() =>
      crowdsecBouncerMiddleware({ lapiHost: BASE.lapiHost, apiKeySecret: { name: '', key: 'k' } })
    ).toThrow('Secret name must not be empty');
    expect(crowdsecSecretUrn({ name: 's', key: 'k' })).toBe('urn:k8s:secret:s:k');
  });

  it('refuses an empty or blank apiKeyFile', () => {
    for (const apiKeyFile of ['', '   ']) {
      expect(() => crowdsecBouncerMiddleware({ lapiHost: BASE.lapiHost, apiKeyFile })).toThrow(
        'apiKeyFile must not be empty'
      );
    }
  });

  it('refuses a plugin name Traefik cannot declare', () => {
    for (const pluginName of ['', 'crowd sec', '1crowdsec', '-crowdsec', 'crowd.sec', 'a${b}']) {
      expect(() => crowdsecBouncerMiddleware({ ...BASE, pluginName })).toThrow(
        /Plugin name .* must match/
      );
    }
    for (const pluginName of ['crowdsec', 'Bouncer_2', 'crowdsec-edge']) {
      expect(Object.keys(crowdsecBouncerMiddleware({ ...BASE, pluginName }).plugin)).toEqual([
        pluginName,
      ]);
    }
  });
});

describe('crowdsecBouncerMiddleware with values known only at reconcile time', () => {
  const composition = kubernetesComposition(
    {
      name: 'crowdsec-bouncer-refs',
      kind: 'CrowdsecBouncerRefs',
      spec: type({
        lapiHost: 'string',
        appsecHost: 'string',
        failOpen: 'boolean',
        failClosedAfter: 'number',
      }),
      status: type({ ok: 'boolean' }),
    },
    (spec) => {
      traefikMiddleware({
        name: 'crowdsec',
        namespace: 'traefik',
        id: 'bouncer',
        spec: crowdsecBouncerMiddleware({
          lapiHost: spec.lapiHost,
          appsecHost: spec.appsecHost,
          failOpen: spec.failOpen,
          failClosedAfter: spec.failClosedAfter,
          apiKeySecret: BASE.apiKeySecret,
        }),
      });
      return { ok: true };
    }
  );
  type PluginDoc = { kind?: string; spec?: { plugin?: { crowdsec?: Record<string, unknown> } } };
  const pluginOf = (yaml: string) =>
    (loadAll(yaml) as PluginDoc[]).find((doc) => doc.kind === 'Middleware')?.spec?.plugin?.crowdsec;
  const kroPlugin = () => {
    const rgd = loadAll(composition.toYaml()) as Array<{
      spec?: { resources?: Array<{ template?: PluginDoc }> };
    }>;
    return rgd[0]?.spec?.resources?.find((r) => r.template?.kind === 'Middleware')?.template?.spec
      ?.plugin?.crowdsec;
  };

  it('emits the fail-open choice as CEL instead of deciding it at build time', () => {
    expect(kroPlugin()).toMatchObject({
      updateMaxFailure:
        '${schema.spec.failOpen ? -1 : schema.spec.failClosedAfter < 0 ? 0 : schema.spec.failClosedAfter}',
      crowdsecAppsecUnreachableBlock: '${!schema.spec.failOpen}',
      crowdsecAppsecFailureBlock: '${!schema.spec.failOpen}',
      crowdsecAppsecUnreadableBodyBlock: '${!schema.spec.failOpen}',
    });
  });

  it('turns AppSec on only when the host reference is not empty', () => {
    expect(kroPlugin()).toMatchObject({
      crowdsecAppsecEnabled: '${schema.spec.appsecHost != ""}',
      crowdsecAppsecHost: expect.stringContaining('schema.spec.appsecHost'),
    });
  });

  it('resolves to concrete values in direct mode', () => {
    const direct = (spec: Record<string, unknown>) =>
      pluginOf(composition.factory('direct', { namespace: 'traefik' }).toYaml(spec as never));
    expect(
      direct({ lapiHost: 'lapi:8080', appsecHost: '', failOpen: false, failClosedAfter: 2 })
    ).toMatchObject({ updateMaxFailure: 2, crowdsecAppsecEnabled: false });
    expect(
      direct({
        lapiHost: 'lapi:8080',
        appsecHost: 'appsec:7422',
        failOpen: true,
        failClosedAfter: 4,
      })
    ).toMatchObject({
      updateMaxFailure: -1,
      crowdsecAppsecEnabled: true,
      crowdsecAppsecUnreachableBlock: false,
    });
  });
});

describe('crowdsecBouncerMiddleware validation', () => {
  const rejects = (
    options: Partial<Parameters<typeof crowdsecBouncerMiddleware>[0]>,
    message: RegExp
  ) => expect(() => crowdsecBouncerMiddleware({ ...BASE, ...options })).toThrow(message);

  it('treats an empty or blank appsecHost as AppSec off', () => {
    for (const appsecHost of ['', '  ']) {
      const config = crowdsecBouncerMiddleware({ ...BASE, appsecHost, failOpen: false }).plugin
        .crowdsec;
      expect(config?.crowdsecAppsecEnabled).toBe(false);
      expect(config?.crowdsecAppsecHost).toBeUndefined();
      expect(config?.crowdsecAppsecUnreachableBlock).toBeUndefined();
    }
  });

  it('refuses hosts the plugin cannot build a URL from', () => {
    rejects({ lapiHost: '' }, /lapiHost must not be empty/);
    rejects({ lapiHost: 'http://lapi:8080' }, /without a scheme/);
    rejects({ lapiHost: 'lapi:8080/v1' }, /host\[:port\]/);
    rejects({ appsecHost: 'https://appsec:7422' }, /without a scheme/);
    expect(() => crowdsecBouncerMiddleware({ ...BASE, lapiHost: '[fd00::1]:8080' })).not.toThrow();
  });

  it('refuses intervals and limits the plugin rejects', () => {
    rejects({ updateIntervalSeconds: 0 }, /updateIntervalSeconds must be an integer of at least 1/);
    rejects({ updateIntervalSeconds: 1.5 }, /updateIntervalSeconds/);
    rejects({ appsecBodyLimit: -1 }, /appsecBodyLimit must be an integer of at least 0/);
    expect(() =>
      crowdsecBouncerMiddleware({ ...BASE, updateIntervalSeconds: 1, appsecBodyLimit: 0 })
    ).not.toThrow();
  });

  it('warns that failClosedAfter is ignored when failing open', () => {
    const warn = spyOn(Object.getPrototypeOf(getComponentLogger('crowdsec-bouncer')), 'warn');
    try {
      const config = crowdsecBouncerMiddleware({ ...BASE, failClosedAfter: 2 }).plugin.crowdsec;
      expect(config?.updateMaxFailure).toBe(-1);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('failClosedAfter is ignored'))
      ).toBe(true);
      warn.mockClear();
      crowdsecBouncerMiddleware({ ...BASE, failOpen: false, failClosedAfter: 2 });
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('failClosedAfter is ignored'))
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses trusted IPs that are not addresses or ranges, and any /0', () => {
    for (const list of ['forwardedHeadersTrustedIps', 'clientTrustedIps'] as const) {
      rejects({ [list]: ['10.0.0.0/33'] }, /not an IP address or CIDR range/);
      rejects({ [list]: ['01.2.3.4'] }, /not an IP address or CIDR range/);
      rejects({ [list]: ['1.2.3.4:80'] }, /not an IP address or CIDR range/);
      rejects({ [list]: ['0.0.0.0/0'] }, /matches every address/);
      rejects({ [list]: ['::/0'] }, /matches every address/);
      rejects({ [list]: ['10.0.0.0/00'] }, /matches every address/);
    }
    rejects({ clientTrustedIps: ['0.0.0.0/0'] }, /bypass the bouncer/);
    rejects({ forwardedHeadersTrustedIps: ['::/0'] }, /X-Forwarded-For/);
    expect(() =>
      crowdsecBouncerMiddleware({
        ...BASE,
        forwardedHeadersTrustedIps: ['10.0.0.0/8', '::ffff:192.0.2.1', '2001:db8::/32'],
        clientTrustedIps: ['192.0.2.1'],
      })
    ).not.toThrow();
  });

  it('checks Secret names and keys against Kubernetes rules', () => {
    expect(() => crowdsecSecretUrn({ name: 'Crowdsec_Key', key: 'k' })).toThrow(
      /DNS-1123 subdomain/
    );
    expect(() => crowdsecSecretUrn({ name: 'a'.repeat(254), key: 'k' })).toThrow(
      /DNS-1123 subdomain/
    );
    expect(() => crowdsecSecretUrn({ name: 'crowdsec', key: 'api key' })).toThrow(
      /letters, digits/
    );
    expect(() => crowdsecSecretUrn({ name: 'crowdsec', key: 'api/key' })).toThrow(
      /letters, digits/
    );
    expect(crowdsecSecretUrn({ name: 'crowdsec.bouncer', key: 'API_key-1.txt' })).toBe(
      'urn:k8s:secret:crowdsec.bouncer:API_key-1.txt'
    );
  });

  it('reads IPs the way Go does in the bootstrap allowlist too', () => {
    expect(() =>
      assertCrowdsecBootstrapOptions({ allowlist: { ips: ['::ffff:1.2.3.4'] } })
    ).not.toThrow();
    for (const ip of [':', '01.2.3.4', 'fe80::1%eth0', '1.2.3.4:80']) {
      expect(() => assertCrowdsecBootstrapOptions({ allowlist: { ips: [ip] } })).toThrow(
        /not an IPv4 or IPv6 address/
      );
    }
  });
});

describe('typekro/crowdsec exports', () => {
  it('exports the bootstrap, resources, helpers and schemas', () => {
    expect(crowdsec.crowdsecBootstrap).toBeDefined();
    expect(crowdsec.makeCrowdsecBootstrap).toBeTypeOf('function');
    expect(crowdsec.crowdsecHelmRepositoryBootstrap).toBeDefined();
    expect(crowdsec.crowdsecHelmRelease).toBeTypeOf('function');
    expect(crowdsec.crowdsecHelmRepository).toBeTypeOf('function');
    expect(crowdsec.mapCrowdsecConfigToHelmValues).toBeTypeOf('function');
    expect(crowdsec.CrowdsecBootstrapConfigSchema).toBeDefined();
    expect(crowdsec.CrowdsecBootstrapStatusSchema).toBeDefined();
    expect(crowdsec.DEFAULT_CROWDSEC_CHART_VERSION).toBe('0.24.2');
    expect(crowdsec.DEFAULT_CROWDSEC_APP_VERSION).toBe('v1.8.1');
  });

  it('stays out of the root factories barrel', () => {
    expect('crowdsec' in factories).toBe(false);
    expect('crowdsecBootstrap' in factories).toBe(false);
  });
});
