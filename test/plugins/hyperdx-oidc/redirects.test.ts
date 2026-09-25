/**
 * HyperDX OIDC plugin — redirect targets.
 *
 * HyperDX's UI proxies `/api/*` to the API server and rewrites a relative
 * `Location` to the API server's port whenever the request's Host header has
 * no port, which is every request through a reverse proxy on the default
 * port. So the plugin builds absolute redirects from a configured public URL,
 * and never from the Host header.
 */

import { describe, expect, it } from 'bun:test';
import {
  isSameOriginPath,
  providerLoginPath,
  publicBase,
  publicUrl,
} from '../../../plugins/hyperdx-oidc/src/redirects.js';

describe('publicBase', () => {
  it('normalizes a public URL to origin plus path, without a trailing slash', () => {
    expect(publicBase('https://hyperdx.example.com')).toBe('https://hyperdx.example.com');
    expect(publicBase('https://hyperdx.example.com/')).toBe('https://hyperdx.example.com');
    expect(publicBase('https://example.com/hyperdx//')).toBe('https://example.com/hyperdx');
    expect(publicBase('HTTPS://HyperDX.Example.com:443/')).toBe('https://hyperdx.example.com');
    expect(publicBase('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('takes the first usable candidate', () => {
    expect(publicBase(undefined, 'https://b.example')).toBe('https://b.example');
    expect(publicBase('', '  ', 'https://c.example')).toBe('https://c.example');
    expect(publicBase('https://a.example', 'https://b.example')).toBe('https://a.example');
  });

  it('skips candidates that are not a plain http(s) base URL', () => {
    for (const bad of [
      'hyperdx.example.com',
      '/relative',
      'localhost:8080',
      'javascript:alert(1)',
      'ftp://hyperdx.example.com',
      'https://user:pw@hyperdx.example.com',
      'https://hyperdx.example.com/?next=https://evil.example',
      'https://hyperdx.example.com/#frag',
    ]) {
      expect([bad, publicBase(bad)]).toEqual([bad, '']);
      expect([bad, publicBase(bad, 'https://ok.example')]).toEqual([bad, 'https://ok.example']);
    }
  });

  it("returns '' when nothing is configured (redirects stay relative)", () => {
    expect(publicBase()).toBe('');
    expect(publicBase(undefined, '')).toBe('');
  });
});

describe('publicUrl', () => {
  it('appends a same-origin path to the base', () => {
    expect(publicUrl('https://hyperdx.example.com', '/api/login/oidc/sso')).toBe(
      'https://hyperdx.example.com/api/login/oidc/sso'
    );
    expect(publicUrl('https://example.com/hyperdx', '/login?err=passwordAuthNotAllowed')).toBe(
      'https://example.com/hyperdx/login?err=passwordAuthNotAllowed'
    );
  });

  it('is relative with no base', () => {
    expect(publicUrl('', '/search')).toBe('/search');
  });

  it('never leaves the public origin: a non-path becomes /', () => {
    for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'evil', '']) {
      expect([bad, publicUrl('https://hyperdx.example.com', bad)]).toEqual([
        bad,
        'https://hyperdx.example.com/',
      ]);
      expect([bad, publicUrl('', bad)]).toEqual([bad, '/']);
    }
  });

  it('refuses whitespace and control characters (a browser drops "\\t" from "/\\t/evil", leaving "//evil")', () => {
    for (const bad of [
      '/\t/evil.example',
      '/\n/evil.example',
      '/ /evil.example',
      '/a\u0000b',
      '/a\u001fb',
      '/a\u007fb',
    ]) {
      expect([JSON.stringify(bad), publicUrl('https://hyperdx.example.com', bad)]).toEqual([
        JSON.stringify(bad),
        'https://hyperdx.example.com/',
      ]);
    }
  });
});

describe('isSameOriginPath', () => {
  it('accepts plain paths, with encoded characters', () => {
    for (const good of ['/', '/search', '/search?q=a%20b&x=1', '/a/b#c', '/%2F%2Fevil']) {
      expect([good, isSameOriginPath(good)]).toEqual([good, true]);
    }
  });

  it('refuses anything a browser could resolve off the origin', () => {
    for (let code = 0; code <= 0x20; code++) {
      expect([code, isSameOriginPath(`/a${String.fromCharCode(code)}b`)]).toEqual([code, false]);
    }
    for (const bad of ['/a\u007fb', '//evil', '/\\evil', 'evil', '', 'https://evil.example']) {
      expect([JSON.stringify(bad), isSameOriginPath(bad)]).toEqual([JSON.stringify(bad), false]);
    }
  });
});

describe('providerLoginPath', () => {
  it('omits the default returnTo and encodes any other', () => {
    expect(providerLoginPath('/api/login/oidc', 'sso', '/')).toBe('/api/login/oidc/sso');
    expect(providerLoginPath('/api/login/oidc', 'sso', '/search?q=a%20b&x=1')).toBe(
      '/api/login/oidc/sso?returnTo=%2Fsearch%3Fq%3Da%2520b%26x%3D1'
    );
  });

  it('builds the absolute chooser redirect behind a reverse proxy', () => {
    const base = publicBase(undefined, 'https://hyperdx.example.com');
    expect(publicUrl(base, providerLoginPath('/api/login/oidc', 'sso', '/dashboards'))).toBe(
      'https://hyperdx.example.com/api/login/oidc/sso?returnTo=%2Fdashboards'
    );
  });
});
