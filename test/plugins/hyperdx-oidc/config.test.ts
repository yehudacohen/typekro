/**
 * HyperDX OIDC plugin — configuration parsing and validation.
 *
 * The configuration is re-read at runtime, and an invalid document is
 * rejected while the previous one keeps serving, so every rule here is a rule
 * that protects a live HyperDX from a typo in a Secret.
 */

import { describe, expect, it } from 'bun:test';
import { OidcConfigError, parseDuration, parseOidcPluginConfig } from '../../../plugins/hyperdx-oidc/src/config.js';

const provider = (overrides: Record<string, unknown> = {}) => ({
  id: 'cognito',
  issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_abc',
  clientId: 'client',
  clientSecret: 'secret',
  allow: { groups: ['hyperdx-users'] },
  ...overrides,
});

const parse = (doc: unknown) => parseOidcPluginConfig(JSON.stringify(doc));

describe('parseOidcPluginConfig', () => {
  it('applies defaults', () => {
    const config = parse({ providers: [provider()] });
    const [p] = config.providers;
    expect(p).toMatchObject({
      id: 'cognito',
      displayName: 'cognito',
      tokenEndpointAuthMethod: 'client_secret_basic',
      scopes: ['openid', 'email', 'profile'],
      claims: { email: 'email', groups: 'groups', name: 'name' },
      requireVerifiedEmail: true,
      linkExistingUsersByEmail: true,
      createUsers: true,
    });
    expect(config.passwordLogin).toBe(true);
    expect(config.maxSessionAgeMs).toBe(12 * 3_600_000);
    expect(config.apiPathPrefix).toBe('/api');
    expect(config.allowInsecureHttp).toBe(false);
  });

  it('accepts an empty provider list (OIDC wired but not yet configured)', () => {
    expect(parse({ providers: [] }).providers).toEqual([]);
  });

  it('refuses a provider with no allow rule — it would admit the whole IdP', () => {
    expect(() => parse({ providers: [provider({ allow: undefined })] })).toThrow(/allow is required/);
    expect(() => parse({ providers: [provider({ allow: {} })] })).toThrow(/at least one of groups or emailDomains/);
    expect(() => parse({ providers: [provider({ allow: { groups: [] } })] })).toThrow(/at least one/);
  });

  it('normalizes email domains to lowercase without a leading @', () => {
    const config = parse({ providers: [provider({ allow: { emailDomains: ['@Example.COM'] } })] });
    expect(config.providers[0]?.allow.emailDomains).toEqual(['example.com']);
  });

  it('refuses plain-http issuers unless allowInsecureHttp is set', () => {
    expect(() => parse({ providers: [provider({ issuer: 'http://idp.local' })] })).toThrow(/must use https/);
    expect(parse({ allowInsecureHttp: true, providers: [provider({ issuer: 'http://idp.local' })] }).providers[0]?.issuer).toBe(
      'http://idp.local'
    );
  });

  it('refuses unknown keys, so a typo cannot silently disable a rule', () => {
    expect(() => parse({ providers: [provider({ alow: { groups: ['x'] } })] })).toThrow(/unknown key\(s\) "alow"/);
    expect(() => parse({ providers: [provider({ allow: { group: ['x'] } })] })).toThrow(/unknown key/);
    expect(() => parse({ providers: [], passwordLogn: false })).toThrow(/unknown key/);
  });

  it('refuses duplicate and malformed provider ids', () => {
    expect(() => parse({ providers: [provider(), provider()] })).toThrow(/used twice/);
    expect(() => parse({ providers: [provider({ id: 'Bad_Id' })] })).toThrow(/lowercase letters/);
  });

  it('requires the openid scope', () => {
    expect(() => parse({ providers: [provider({ scopes: ['email'] })] })).toThrow(/must include "openid"/);
  });

  it('strips trailing slashes from issuer and redirect base', () => {
    const config = parse({ redirectBaseUrl: 'https://hyperdx.example/', providers: [provider({ issuer: 'https://idp.example/' })] });
    expect(config.redirectBaseUrl).toBe('https://hyperdx.example');
    expect(config.providers[0]?.issuer).toBe('https://idp.example');
  });

  it('reports invalid JSON without echoing the source (it holds client secrets)', () => {
    let message = '';
    try {
      parseOidcPluginConfig('{"providers":[{"clientSecret":SUPERSECRET}]}');
    } catch (error) {
      expect(error).toBeInstanceOf(OidcConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain('SUPERSECRET');
  });

  it('defaults email linking to off when verification is off, and refuses turning it on', () => {
    const config = parse({ providers: [provider({ requireVerifiedEmail: false, allow: { emailDomains: ['example.com'] } })] });
    expect(config.providers[0]?.linkExistingUsersByEmail).toBe(false);
    expect(() =>
      parse({ providers: [provider({ requireVerifiedEmail: false, linkExistingUsersByEmail: true })] })
    ).toThrow(/cannot be true when requireVerifiedEmail is false/);
  });
});

describe('parseDuration', () => {
  it('parses units and bare seconds', () => {
    expect(parseDuration('12h', 'x')).toBe(12 * 3_600_000);
    expect(parseDuration('30m', 'x')).toBe(30 * 60_000);
    expect(parseDuration('7d', 'x')).toBe(7 * 86_400_000);
    expect(parseDuration(90, 'x')).toBe(90_000);
    expect(parseDuration(0, 'x')).toBe(0);
  });

  it('refuses nonsense', () => {
    expect(() => parseDuration('soon', 'maxSessionAge')).toThrow(/maxSessionAge must be a duration/);
    expect(() => parseDuration(-1, 'x')).toThrow();
  });
});
