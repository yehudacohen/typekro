/**
 * Traefik side of CrowdSec: the plugin declaration, the bouncer Middleware
 * spec and its fail-open / fail-closed mapping, and the export surface.
 */
import { describe, expect, it } from 'bun:test';

import * as crowdsec from '../../../src/factories/crowdsec/index.js';
import {
  CROWDSEC_BOUNCER_PLUGIN_MODULE,
  crowdsecBouncerMiddleware,
  crowdsecSecretUrn,
  crowdsecTraefikPlugin,
  DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH,
} from '../../../src/factories/crowdsec/index.js';
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
    expect(() => crowdsecBouncerMiddleware({ ...BASE, failClosedAfter: -1 })).toThrow(
      /non-negative/
    );
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
