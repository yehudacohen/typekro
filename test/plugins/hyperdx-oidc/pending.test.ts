/**
 * HyperDX OIDC plugin — pending sign-ins, stored outside the session and
 * bound to the browser by a per-sign-in cookie.
 *
 * One browser can start and complete several sign-ins at once (a reverse
 * proxy that starts sign-in for every signed-out page load, with several
 * tabs restored together). Each must complete on its own entry, exactly once,
 * only in the browser that started it, within the time limit, and a browser's
 * entries stay bounded. In HyperDX the atomicity comes from MongoDB's
 * findOneAndDelete; the in-memory store here is atomic the same way.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_RETURN_TO_LENGTH,
  PENDING_LOGIN_TTL_MS,
  type PendingLogin,
  safeReturnTo,
} from '../../../plugins/hyperdx-oidc/src/oidc.js';
import {
  BINDING_COOKIE_PREFIX,
  beginPendingLogin,
  bindingCookieName,
  bindingCookieOptions,
  hashBinding,
  MAX_PENDING_LOGINS,
  type PendingLoginRecord,
  type PendingLoginStore,
  parseCookies,
  takePendingLogin,
} from '../../../plugins/hyperdx-oidc/src/pending.js';

const NOW = 1_700_000_000_000;
const COOKIE = { path: '/api/login/oidc', secure: true };

/** In memory, and atomic as findOneAndDelete is: nothing awaits between the find and the delete. */
class MemoryStore implements PendingLoginStore {
  readonly records: PendingLoginRecord[] = [];
  async insert(record: PendingLoginRecord) {
    if (this.records.some((existing) => existing.state === record.state))
      throw new Error('duplicate state');
    this.records.push(record);
  }
  async take(state: string, bindingHash: string, provider: string, now: Date) {
    const index = this.records.findIndex(
      (record) =>
        record.state === state &&
        record.bindingHash === bindingHash &&
        record.provider === provider &&
        record.expiresAt > now
    );
    return index === -1 ? null : this.records.splice(index, 1)[0];
  }
  async listByBinding(bindingHashes: readonly string[], now: Date) {
    return this.records.filter(
      (record) => bindingHashes.includes(record.bindingHash) && record.expiresAt > now
    );
  }
  async removeByBinding(bindingHashes: readonly string[]) {
    for (let index = this.records.length - 1; index >= 0; index--) {
      if (bindingHashes.includes((this.records[index] as PendingLoginRecord).bindingHash))
        this.records.splice(index, 1);
    }
  }
}

/** A cookie jar that applies Set-Cookie values as a browser does (`Max-Age=0` removes). */
class Jar {
  readonly cookies = new Map<string, string>();
  apply(setCookies: readonly string[]) {
    for (const header of setCookies) {
      const [pair] = header.split(';');
      const index = (pair as string).indexOf('=');
      const name = (pair as string).slice(0, index);
      if (/;\s*Max-Age=0(;|$)/.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, (pair as string).slice(index + 1));
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** States the length the plugin issues (43 base64url characters). */
const stateOf = (tag: string) => tag.padEnd(43, 'x');

const pendingOf = (tag: string, createdAt = NOW): PendingLogin => ({
  provider: 'mock',
  state: stateOf(tag),
  nonce: `nonce-${tag}`,
  codeVerifier: `verifier-${tag}`,
  returnTo: `/${tag}`,
  createdAt,
});

/** Start sign-ins as concurrent requests do: each sees the jar as it was before any of them answered. */
async function startTogether(
  store: PendingLoginStore,
  jar: Jar,
  tags: readonly string[],
  at = NOW
) {
  const header = jar.header();
  const responses = await Promise.all(
    tags.map((tag) => beginPendingLogin(store, header, pendingOf(tag, at), COOKIE, at))
  );
  for (const setCookies of responses) jar.apply(setCookies);
}

async function callback(
  store: PendingLoginStore,
  jar: Jar,
  tag: string,
  at = NOW + 1_000,
  provider = 'mock'
) {
  const result = await takePendingLogin(store, jar.header(), stateOf(tag), provider, COOKIE, at);
  jar.apply(result.setCookies);
  return result.pending;
}

describe('pending sign-ins', () => {
  it('gives sign-ins started at the same moment, with no cookie yet, a binding each', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a', 'b']);
    expect([...jar.cookies.keys()].sort()).toEqual(
      [bindingCookieName(stateOf('a')), bindingCookieName(stateOf('b'))].sort()
    );
    expect(store.records.map((record) => record.state).sort()).toEqual([
      stateOf('a'),
      stateOf('b'),
    ]);
  });

  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    it(`completes both sign-ins when the callbacks return ${order.join(' then ')}`, async () => {
      const store = new MemoryStore();
      const jar = new Jar();
      await startTogether(store, jar, ['a', 'b']);
      for (const tag of order) {
        // Each callback gets its own nonce, verifier and returnTo.
        expect(await callback(store, jar, tag)).toEqual(pendingOf(tag));
      }
      expect(store.records).toEqual([]);
      // Each callback clears its own binding cookie.
      expect(jar.cookies.size).toBe(0);
    });
  }

  it('completes callbacks that run at the same moment, each exactly once', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a', 'b']);
    const header = jar.header();
    // Both callbacks, each twice, all at once: exactly one success per state.
    const results = await Promise.all(
      ['a', 'b', 'a', 'b'].map((tag) =>
        takePendingLogin(store, header, stateOf(tag), 'mock', COOKIE, NOW + 1_000)
      )
    );
    const taken = results.flatMap((result) =>
      result.pending === undefined ? [] : [result.pending.state]
    );
    expect(taken.sort()).toEqual([stateOf('a'), stateOf('b')]);
  });

  it('refuses a replayed callback at the lookup', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a', 'b']);
    const header = jar.header();
    const first = await takePendingLogin(store, header, stateOf('a'), 'mock', COOKIE, NOW + 1_000);
    expect(first.pending?.state).toBe(stateOf('a'));
    // The same request again, cookie and all.
    expect(
      (await takePendingLogin(store, header, stateOf('a'), 'mock', COOKIE, NOW + 1_000)).pending
    ).toBeUndefined();
    // The other sign-in is untouched.
    expect(store.records.map((record) => record.state)).toEqual([stateOf('b')]);
  });

  it("refuses a callback in a browser without the sign-in's binding, and leaves the entry", async () => {
    const store = new MemoryStore();
    const victim = new Jar();
    await startTogether(store, victim, ['a']);
    // Another browser (login CSRF: a state and code carried elsewhere), then a forged cookie.
    const other = new Jar();
    expect(await callback(store, other, 'a')).toBeUndefined();
    other.cookies.set(bindingCookieName(stateOf('a')), 'forged');
    expect(await callback(store, other, 'a')).toBeUndefined();
    expect(store.records).toHaveLength(1);
    // The browser that started it still completes it.
    expect(await callback(store, victim, 'a')).toEqual(pendingOf('a'));
  });

  it('refuses an expired sign-in, and clears its cookie', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a']);
    expect(await callback(store, jar, 'a', NOW + PENDING_LOGIN_TTL_MS)).toBeUndefined();
    expect(jar.cookies.size).toBe(0);
  });

  it('refuses a sign-in presented at another provider', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a']);
    expect(await callback(store, jar, 'a', NOW + 1_000, 'second')).toBeUndefined();
  });

  it('takes nothing for a missing, repeated, oversized or unknown state', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a']);
    for (const state of [
      undefined,
      '',
      [stateOf('a'), stateOf('a')],
      'x'.repeat(513),
      stateOf('z'),
    ]) {
      const { pending } = await takePendingLogin(
        store,
        jar.header(),
        state,
        'mock',
        COOKIE,
        NOW + 1_000
      );
      expect([state, pending]).toEqual([state, undefined]);
    }
    expect(store.records).toHaveLength(1);
  });

  it(`keeps at most ${MAX_PENDING_LOGINS} sign-ins per browser, evicting the oldest`, async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    const tags = Array.from({ length: MAX_PENDING_LOGINS + 2 }, (_, index) => `t${index}`);
    for (const [index, tag] of tags.entries()) await startTogether(store, jar, [tag], NOW + index);
    expect(store.records.map((record) => record.state)).toEqual(tags.slice(2).map(stateOf));
    expect(jar.cookies.size).toBe(MAX_PENDING_LOGINS);
    // The evicted sign-ins' cookies are cleared, and they cannot complete.
    expect(jar.cookies.has(bindingCookieName(stateOf('t0')))).toBe(false);
    expect(await callback(store, jar, 't0', NOW + 100)).toBeUndefined();
    expect(await callback(store, jar, `t${MAX_PENDING_LOGINS + 1}`, NOW + 100)).toBeDefined();
  });

  it('clears binding cookies whose sign-in is gone once the browser is at the cap', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    for (let index = 0; index < MAX_PENDING_LOGINS; index++) {
      jar.cookies.set(`${BINDING_COOKIE_PREFIX}stale${index}`, `stale-${index}`);
    }
    await startTogether(store, jar, ['a']);
    expect([...jar.cookies.keys()]).toEqual([bindingCookieName(stateOf('a'))]);
  });

  it('stores only a hash of the binding, and expires with the time limit', async () => {
    const store = new MemoryStore();
    const jar = new Jar();
    await startTogether(store, jar, ['a']);
    const binding = jar.cookies.get(bindingCookieName(stateOf('a'))) as string;
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.records[0]?.bindingHash).toBe(hashBinding(binding));
    expect(JSON.stringify(store.records)).not.toContain(binding);
    expect(store.records[0]?.expiresAt.getTime()).toBe(NOW + PENDING_LOGIN_TTL_MS);
  });

  it('sets the binding cookie HttpOnly, SameSite=Lax, scoped to the login routes, Secure on https', async () => {
    expect(bindingCookieOptions('https://hdx.example/api/login/oidc/mock/callback')).toEqual({
      path: '/api/login/oidc',
      secure: true,
    });
    expect(
      bindingCookieOptions('http://localhost:8080/hyperdx/api/login/oidc/mock/callback')
    ).toEqual({
      path: '/hyperdx/api/login/oidc',
      secure: false,
    });
    const [set] = await beginPendingLogin(
      new MemoryStore(),
      undefined,
      pendingOf('a'),
      COOKIE,
      NOW
    );
    expect(set).toMatch(
      new RegExp(
        `^${bindingCookieName(stateOf('a'))}=[A-Za-z0-9_-]{43}; Path=/api/login/oidc; Max-Age=600; HttpOnly; SameSite=Lax; Secure$`
      )
    );
  });

  it('parses a Cookie header, keeping the first value of a repeated name', () => {
    expect([...parseCookies('a=1; b = 2 ;junk; a=3; c=')]).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', ''],
    ]);
    expect(parseCookies(undefined).size).toBe(0);
  });
});

describe('safeReturnTo', () => {
  it(`keeps a same-origin path up to ${MAX_RETURN_TO_LENGTH} characters, and sends anything else to /`, () => {
    const longest = `/${'a'.repeat(MAX_RETURN_TO_LENGTH - 1)}`;
    expect(safeReturnTo(longest)).toBe(longest);
    expect(safeReturnTo(`${longest}a`)).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo(['/a'])).toBe('/');
  });
});
