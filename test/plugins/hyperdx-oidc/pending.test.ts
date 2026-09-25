/**
 * HyperDX OIDC plugin — pending sign-ins, keyed by `state`.
 *
 * One browser can start several sign-ins before any returns (a reverse proxy
 * that starts sign-in for every signed-out page load, with several tabs
 * restored at once). Each must complete on its own entry, and every entry
 * must still be single-use, time-limited and bounded in number.
 */

import { describe, expect, it } from 'bun:test';
import { PENDING_LOGIN_TTL_MS, type PendingLogin } from '../../../plugins/hyperdx-oidc/src/oidc.js';
import {
  addPendingLogin,
  livePendingLogins,
  MAX_PENDING_LOGINS,
  takePendingLogin,
} from '../../../plugins/hyperdx-oidc/src/pending.js';

const NOW = 1_700_000_000_000;

/** States the length the plugin issues (43 base64url characters). */
const stateOf = (tag: string) => tag.padEnd(43, 'x');

const entry = (tag: string, createdAt = NOW): PendingLogin => ({
  provider: 'mock',
  state: stateOf(tag),
  nonce: `nonce-${tag}`,
  codeVerifier: `verifier-${tag}`,
  returnTo: `/${tag}`,
  createdAt,
});

/** Start sign-ins in order, one millisecond apart, as a session would store them. */
function started(...tags: string[]): PendingLogin[] {
  let stored: PendingLogin[] | undefined;
  tags.forEach((tag, index) => {
    stored = addPendingLogin(stored, entry(tag, NOW + index), NOW + index);
  });
  return stored ?? [];
}

describe('pending sign-ins', () => {
  it('keeps a second sign-in alongside the first instead of replacing it', () => {
    const stored = started('a', 'b');
    expect(stored.map((pending) => pending.state)).toEqual([stateOf('a'), stateOf('b')]);
  });

  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    it(`completes both sign-ins when the callbacks return ${order.join(' then ')}`, () => {
      let stored: unknown = started('a', 'b');
      for (const tag of order) {
        const { pending, remaining } = takePendingLogin(stored, stateOf(tag), NOW + 10);
        // Each callback gets its own nonce, verifier and returnTo.
        expect(pending).toEqual(entry(tag, NOW + (tag === 'a' ? 0 : 1)));
        expect(remaining.some((other) => other.state === stateOf(tag))).toBe(false);
        stored = remaining;
      }
      expect(stored).toEqual([]);
    });
  }

  it('refuses a replayed state: an entry is taken once, whatever the outcome', () => {
    const first = takePendingLogin(started('a', 'b'), stateOf('a'), NOW + 10);
    expect(first.pending?.state).toBe(stateOf('a'));
    const replay = takePendingLogin(first.remaining, stateOf('a'), NOW + 10);
    expect(replay.pending).toBeUndefined();
    // The other sign-in is untouched by the replay.
    expect(replay.remaining.map((pending) => pending.state)).toEqual([stateOf('b')]);
  });

  it('refuses an expired entry and drops it', () => {
    const stored = started('a');
    const atTtl = takePendingLogin(stored, stateOf('a'), NOW + PENDING_LOGIN_TTL_MS);
    expect(atTtl.pending?.state).toBe(stateOf('a'));
    const past = takePendingLogin(stored, stateOf('a'), NOW + PENDING_LOGIN_TTL_MS + 1);
    expect(past.pending).toBeUndefined();
    expect(past.remaining).toEqual([]);
    // Expired entries are pruned when a new sign-in starts, too.
    expect(
      addPendingLogin(
        stored,
        entry('b', NOW + PENDING_LOGIN_TTL_MS + 1),
        NOW + PENDING_LOGIN_TTL_MS + 1
      ).map((p) => p.state)
    ).toEqual([stateOf('b')]);
  });

  it(`keeps at most ${MAX_PENDING_LOGINS} entries, evicting the oldest`, () => {
    const tags = Array.from({ length: MAX_PENDING_LOGINS + 2 }, (_, index) => `t${index}`);
    const stored = started(...tags);
    expect(stored).toHaveLength(MAX_PENDING_LOGINS);
    expect(stored.map((pending) => pending.state)).toEqual(tags.slice(2).map(stateOf));
    expect(takePendingLogin(stored, stateOf('t0'), NOW + 100).pending).toBeUndefined();
    expect(
      takePendingLogin(stored, stateOf(`t${MAX_PENDING_LOGINS + 1}`), NOW + 100).pending
    ).toBeDefined();
  });

  it('takes nothing for a missing, repeated, unknown or differently sized state', () => {
    const stored = started('a');
    for (const state of [
      undefined,
      '',
      [stateOf('a'), stateOf('a')],
      stateOf('z'),
      'a',
      `${stateOf('a')}x`,
    ]) {
      const { pending, remaining } = takePendingLogin(stored, state, NOW + 10);
      expect([state, pending]).toEqual([state, undefined]);
      expect(remaining).toEqual(stored);
    }
  });

  it('ignores a malformed stored value rather than trusting its shape', () => {
    expect(livePendingLogins(undefined, NOW)).toEqual([]);
    // The single entry earlier plugin builds stored, and junk.
    expect(livePendingLogins(entry('a'), NOW)).toEqual([]);
    expect(
      livePendingLogins(
        [null, 'x', { state: stateOf('a') }, { ...entry('b'), createdAt: 'now' }, entry('c')],
        NOW
      )
    ).toEqual([entry('c')]);
  });
});
