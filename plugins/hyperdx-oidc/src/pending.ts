/**
 * Pending sign-ins kept in the HyperDX session between the redirect to the
 * provider and the callback, keyed by `state`.
 *
 * One browser can start several sign-ins before any of them returns: a
 * reverse proxy that starts sign-in for every signed-out page load does this
 * when a browser restores several tabs. Each flow therefore gets its own
 * entry, with its own nonce, PKCE verifier and `returnTo`, and each callback
 * takes only the entry whose `state` it carries:
 *
 * - an entry is removed when a callback takes it, whatever the outcome, so a
 *   replayed `state` finds nothing;
 * - entries older than {@link PENDING_LOGIN_TTL_MS} are dropped on every
 *   read and never match;
 * - at most {@link MAX_PENDING_LOGINS} are kept, the oldest evicted first, so
 *   a client that keeps starting sign-ins cannot grow its session;
 * - entries live in the session, so a `state` from another browser's session
 *   matches nothing here.
 *
 * The session is stored by HyperDX (MongoDB), so what is read back is
 * validated rather than trusted to have the expected shape.
 */

import { timingSafeEqual } from 'node:crypto';
import { PENDING_LOGIN_TTL_MS, type PendingLogin } from './oidc.js';

/** How many sign-ins one session may have in flight at once. */
export const MAX_PENDING_LOGINS = 10;

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.provider === 'string' &&
    typeof entry.state === 'string' &&
    entry.state.length > 0 &&
    typeof entry.nonce === 'string' &&
    typeof entry.codeVerifier === 'string' &&
    typeof entry.returnTo === 'string' &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt)
  );
}

/** The well-formed, unexpired entries of a stored list, oldest first. */
export function livePendingLogins(stored: unknown, now: number): PendingLogin[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(
      (entry): entry is PendingLogin =>
        isPendingLogin(entry) && now - entry.createdAt <= PENDING_LOGIN_TTL_MS
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The stored list with `entry` added: expired entries dropped, then the oldest beyond the cap. */
export function addPendingLogin(stored: unknown, entry: PendingLogin, now: number): PendingLogin[] {
  return [...livePendingLogins(stored, now), entry].slice(-MAX_PENDING_LOGINS);
}

/** Constant-time for equal lengths; every `state` this plugin issues has the same length. */
function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Take the entry a callback's `state` names. The entry is removed from the
 * returned `remaining` list whether or not the callback then succeeds, so it
 * can be used once. A missing, repeated (`?state=a&state=b`) or unknown
 * `state` takes nothing.
 */
export function takePendingLogin(
  stored: unknown,
  state: unknown,
  now: number
): { pending: PendingLogin | undefined; remaining: PendingLogin[] } {
  const live = livePendingLogins(stored, now);
  if (typeof state !== 'string' || state.length === 0)
    return { pending: undefined, remaining: live };
  let pending: PendingLogin | undefined;
  const remaining: PendingLogin[] = [];
  // Compare against every entry, without stopping at a match.
  for (const entry of live) {
    if (sameState(entry.state, state) && pending === undefined) pending = entry;
    else remaining.push(entry);
  }
  return { pending, remaining };
}
