/**
 * Pending sign-ins: what the callback needs (nonce, PKCE verifier,
 * `returnTo`) between the redirect to the provider and the provider's
 * redirect back.
 *
 * They are NOT kept in the HyperDX session. express-session saves the whole
 * session at the end of each request and the last write wins, so sign-ins
 * started or completed at the same moment in one browser overwrite each
 * other's state; a browser with no session yet gets one session per
 * concurrent start and keeps only the last cookie; and Passport regenerates
 * the session on login. Instead each pending sign-in is a document in a
 * plugin-owned collection, keyed by `state`:
 *
 * - **Bound to the browser.** Each sign-in sets its own random binding cookie
 *   (HttpOnly, SameSite=Lax, Secure on https, scoped to the login routes),
 *   named after its `state`. The document stores only a SHA-256 of the
 *   binding. A callback must present the cookie for its own `state`, so a
 *   `state` and code carried to another browser (login CSRF) match nothing.
 *   One cookie per sign-in, rather than one shared cookie, is what lets two
 *   sign-ins started at the same moment in a browser with no cookie yet both
 *   succeed: a shared cookie would be set twice, and the browser would keep
 *   only one of the two values.
 * - **Exactly once.** A callback takes its document with one atomic
 *   find-and-delete on (`state`, binding hash, provider, unexpired), before
 *   any token exchange. A replayed callback URL finds nothing, even when
 *   several callbacks run at once.
 * - **Time-limited.** Documents expire after {@link PENDING_LOGIN_TTL_MS}
 *   (a TTL index removes them, and the lookup refuses expired ones), and so
 *   does the binding cookie.
 * - **Bounded per browser.** A start that sees {@link MAX_PENDING_LOGINS} or
 *   more binding cookies evicts the oldest sign-ins and clears cookies whose
 *   sign-in is gone. Starts racing each other can briefly exceed it by the
 *   number racing.
 *
 * The binding is compared as a hash inside the database lookup, so no timing
 * difference there can reveal the binding itself.
 */

import { createHash, randomBytes } from 'node:crypto';
import { PENDING_LOGIN_TTL_MS, type PendingLogin } from './oidc.js';

/** How many sign-ins one browser may have in flight at once. */
export const MAX_PENDING_LOGINS = 10;

/** Name prefix of the per-sign-in binding cookies. */
export const BINDING_COOKIE_PREFIX = 'typekro_oidc_';

/** Longest `state` a callback may carry; the plugin issues 43 characters. */
const MAX_STATE_LENGTH = 512;

/** A pending sign-in as stored. */
export interface PendingLoginRecord extends PendingLogin {
  /** SHA-256 (hex) of the browser's binding cookie; the raw value is never stored. */
  readonly bindingHash: string;
  /** When the TTL index removes it. */
  readonly expiresAt: Date;
}

/** Where pending sign-ins live (a MongoDB collection in HyperDX; in memory in tests). */
export interface PendingLoginStore {
  insert(record: PendingLoginRecord): Promise<void>;
  /**
   * Atomically remove and return the unexpired record matching `state`,
   * `bindingHash` and `provider`, or `null`. Never returns one record to two
   * callers.
   */
  take(state: string, bindingHash: string, provider: string, now: Date): Promise<unknown>;
  /** The unexpired records with these binding hashes. */
  listByBinding(
    bindingHashes: readonly string[],
    now: Date
  ): Promise<ReadonlyArray<{ readonly bindingHash: string; readonly createdAt: number }>>;
  /** Remove the records with these binding hashes. */
  removeByBinding(bindingHashes: readonly string[]): Promise<void>;
}

/** Attributes of the binding cookies. */
export interface BindingCookieOptions {
  /** The login routes' path as the browser sees it, e.g. `/api/login/oidc`. */
  readonly path: string;
  /** Set `Secure`: the callback is on https. */
  readonly secure: boolean;
}

/**
 * Binding-cookie attributes for a provider's callback URL: scoped to the
 * login routes it sits under, `Secure` when it is https.
 */
export function bindingCookieOptions(redirectUri: string): BindingCookieOptions {
  const url = new URL(redirectUri, 'http://placeholder.invalid');
  const path = url.pathname.replace(/\/[^/]+\/callback$/, '');
  return { path: path === '' ? '/' : path, secure: url.protocol === 'https:' };
}

/** A sign-in's binding-cookie name: derived from its `state`, so its callback can find it. */
export function bindingCookieName(state: string): string {
  return `${BINDING_COOKIE_PREFIX}${createHash('sha256').update(state).digest('base64url').slice(0, 22)}`;
}

export function hashBinding(binding: string): string {
  return createHash('sha256').update(binding).digest('hex');
}

/** Parse a `Cookie` request header. A repeated name keeps its first value. */
export function parseCookies(header: unknown): Map<string, string> {
  const cookies = new Map<string, string>();
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

function setCookie(
  name: string,
  value: string,
  options: BindingCookieOptions,
  maxAgeSeconds: number
): string {
  return (
    `${name}=${value}; Path=${options.path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax` +
    (options.secure ? '; Secure' : '')
  );
}

const clearCookie = (name: string, options: BindingCookieOptions) =>
  setCookie(name, '', options, 0);

/** The binding cookies a browser presented: cookie name by binding hash. */
function presentedBindings(cookieHeader: unknown): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const [name, value] of parseCookies(cookieHeader)) {
    if (name.startsWith(BINDING_COOKIE_PREFIX) && value !== '')
      byHash.set(hashBinding(value), name);
  }
  return byHash;
}

/**
 * Store a new pending sign-in, bound to a fresh cookie.
 *
 * @returns `Set-Cookie` values for the response: the new binding cookie, and
 *   the clearing of any evicted or dead ones.
 */
export async function beginPendingLogin(
  store: PendingLoginStore,
  cookieHeader: unknown,
  pending: PendingLogin,
  cookie: BindingCookieOptions,
  now: number
): Promise<string[]> {
  const setCookies: string[] = [];
  const presented = presentedBindings(cookieHeader);
  if (presented.size >= MAX_PENDING_LOGINS) {
    const live = [...(await store.listByBinding([...presented.keys()], new Date(now)))].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    const liveHashes = new Set(live.map((record) => record.bindingHash));
    const dead = [...presented.keys()].filter((hash) => !liveHashes.has(hash));
    const evicted = live
      .slice(0, Math.max(0, live.length - (MAX_PENDING_LOGINS - 1)))
      .map((record) => record.bindingHash);
    if (evicted.length > 0) await store.removeByBinding(evicted);
    for (const hash of [...dead, ...evicted])
      setCookies.push(clearCookie(presented.get(hash) as string, cookie));
  }
  const binding = randomBytes(32).toString('base64url');
  await store.insert({
    ...pending,
    bindingHash: hashBinding(binding),
    expiresAt: new Date(pending.createdAt + PENDING_LOGIN_TTL_MS),
  });
  setCookies.push(
    setCookie(bindingCookieName(pending.state), binding, cookie, PENDING_LOGIN_TTL_MS / 1000)
  );
  return setCookies;
}

/**
 * Take the pending sign-in a callback's `state` names, if this browser holds
 * its binding cookie: at most once, before anything else happens.
 *
 * @returns The pending sign-in, or `undefined` (missing, repeated or unknown
 *   `state`; no or wrong binding cookie; expired; already taken), and
 *   `Set-Cookie` values clearing this sign-in's binding cookie.
 */
export async function takePendingLogin(
  store: PendingLoginStore,
  cookieHeader: unknown,
  state: unknown,
  provider: string,
  cookie: BindingCookieOptions,
  now: number
): Promise<{ pending: PendingLogin | undefined; setCookies: string[] }> {
  if (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE_LENGTH) {
    return { pending: undefined, setCookies: [] };
  }
  const name = bindingCookieName(state);
  const binding = parseCookies(cookieHeader).get(name);
  if (binding === undefined) return { pending: undefined, setCookies: [] };
  // The cookie is spent whatever the outcome.
  const setCookies = [clearCookie(name, cookie)];
  if (binding === '') return { pending: undefined, setCookies };
  const pending = toPendingLogin(
    await store.take(state, hashBinding(binding), provider, new Date(now))
  );
  const matches = pending !== undefined && pending.state === state && pending.provider === provider;
  return { pending: matches ? pending : undefined, setCookies };
}

/** A stored record as a pending sign-in, or `undefined` if it is not well-formed. */
export function toPendingLogin(record: unknown): PendingLogin | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const entry = record as Record<string, unknown>;
  if (
    typeof entry.provider !== 'string' ||
    typeof entry.state !== 'string' ||
    typeof entry.nonce !== 'string' ||
    typeof entry.codeVerifier !== 'string' ||
    typeof entry.returnTo !== 'string' ||
    typeof entry.createdAt !== 'number' ||
    !Number.isFinite(entry.createdAt)
  ) {
    return undefined;
  }
  return {
    provider: entry.provider,
    state: entry.state,
    nonce: entry.nonce,
    codeVerifier: entry.codeVerifier,
    returnTo: entry.returnTo,
    createdAt: entry.createdAt,
  };
}
