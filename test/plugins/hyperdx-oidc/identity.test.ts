/**
 * HyperDX OIDC plugin — who gets in, and which HyperDX account they get.
 */

import { describe, expect, it } from 'bun:test';
import { type OidcProviderConfig, parseOidcPluginConfig } from '../../../plugins/hyperdx-oidc/src/config.js';
import {
  evaluateClaims,
  type IdentityStore,
  LinkConflictError,
  normalizeGroups,
  resolveAccount,
  type VerifiedIdentity,
} from '../../../plugins/hyperdx-oidc/src/identity.js';
import { safeReturnTo } from '../../../plugins/hyperdx-oidc/src/oidc.js';
import { renderChooser, renderDenied } from '../../../plugins/hyperdx-oidc/src/pages.js';

function providerWith(overrides: Record<string, unknown> = {}): OidcProviderConfig {
  const config = parseOidcPluginConfig(
    JSON.stringify({
      providers: [
        {
          id: 'idp',
          issuer: 'https://idp.example',
          clientId: 'c',
          clientSecret: 's',
          allow: { groups: ['hyperdx-users'] },
          ...overrides,
        },
      ],
    })
  );
  return config.providers[0] as OidcProviderConfig;
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  email: 'Alice@Example.com',
  email_verified: true,
  groups: ['hyperdx-users'],
  name: 'Alice',
  ...overrides,
});

describe('evaluateClaims', () => {
  it('admits a verified member of an allowed group, with a lowercased email', () => {
    const decision = evaluateClaims(providerWith(), claims());
    expect(decision).toEqual({
      allowed: true,
      identity: { provider: 'idp', subject: 'user-1', email: 'alice@example.com', name: 'Alice', groups: ['hyperdx-users'] },
    });
  });

  it('refuses outside the allowed groups', () => {
    expect(evaluateClaims(providerWith(), claims({ groups: ['other'] }))).toEqual({ allowed: false, reason: 'groupNotAllowed' });
    expect(evaluateClaims(providerWith(), claims({ groups: undefined }))).toEqual({ allowed: false, reason: 'groupNotAllowed' });
  });

  it('refuses an unverified email by default, accepts the string "true"', () => {
    expect(evaluateClaims(providerWith(), claims({ email_verified: false }))).toEqual({ allowed: false, reason: 'emailNotVerified' });
    expect(evaluateClaims(providerWith(), claims({ email_verified: undefined }))).toEqual({ allowed: false, reason: 'emailNotVerified' });
    expect(evaluateClaims(providerWith(), claims({ email_verified: 'true' })).allowed).toBe(true);
    expect(evaluateClaims(providerWith({ requireVerifiedEmail: false }), claims({ email_verified: undefined })).allowed).toBe(true);
  });

  it('requires EVERY configured rule: group AND email domain', () => {
    const both = providerWith({ allow: { groups: ['hyperdx-users'], emailDomains: ['example.com'] } });
    expect(evaluateClaims(both, claims()).allowed).toBe(true);
    expect(evaluateClaims(both, claims({ email: 'alice@evil.test' }))).toEqual({ allowed: false, reason: 'emailDomainNotAllowed' });
    expect(evaluateClaims(both, claims({ groups: [] }))).toEqual({ allowed: false, reason: 'groupNotAllowed' });
  });

  it('matches an email-domain rule exactly (no suffix tricks)', () => {
    const domains = providerWith({ allow: { emailDomains: ['example.com'] } });
    expect(evaluateClaims(domains, claims({ email: 'x@example.com.evil.test' })).allowed).toBe(false);
    expect(evaluateClaims(domains, claims({ email: 'x@sub.example.com' })).allowed).toBe(false);
  });

  it('reads provider-specific claim names (e.g. Cognito groups, Entra roles)', () => {
    const cognito = providerWith({ claims: { groups: 'cognito:groups' } });
    expect(evaluateClaims(cognito, claims({ groups: undefined, 'cognito:groups': ['hyperdx-users'] })).allowed).toBe(true);
    const entra = providerWith({ claims: { groups: 'roles', email: 'preferred_username' } });
    expect(
      evaluateClaims(entra, claims({ groups: undefined, email: undefined, roles: 'hyperdx-users', preferred_username: 'a@example.com' }))
        .allowed
    ).toBe(true);
  });

  it('refuses a non-ASCII email before case-folding (Unicode look-alikes)', () => {
    // "\u212A" (KELVIN SIGN) lowercases to "k": without the check this would
    // become "kevin@example.com" and could match someone else's account.
    expect(evaluateClaims(providerWith(), claims({ email: '\u212Aevin@example.com' }))).toEqual({
      allowed: false,
      reason: 'emailInvalid',
    });
    expect(evaluateClaims(providerWith(), claims({ email: 'k\u00e9vin@example.com' }))).toEqual({
      allowed: false,
      reason: 'emailInvalid',
    });
  });

  it('refuses a missing subject or email', () => {
    expect(evaluateClaims(providerWith(), claims({ sub: undefined }))).toEqual({ allowed: false, reason: 'subjectMissing' });
    expect(evaluateClaims(providerWith(), claims({ email: 'not-an-email' }))).toEqual({ allowed: false, reason: 'emailMissing' });
  });

  it('falls back to the email for the display name', () => {
    const decision = evaluateClaims(providerWith(), claims({ name: '  ' }));
    expect(decision.allowed && decision.identity.name).toBe('alice@example.com');
  });
});

describe('normalizeGroups', () => {
  it('accepts arrays and single strings, drops non-strings', () => {
    expect(normalizeGroups(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(normalizeGroups('a')).toEqual(['a']);
    expect(normalizeGroups(undefined)).toEqual([]);
  });
});

/** An in-memory IdentityStore that records what happened. */
function memoryStore(initial: { users?: Record<string, string>; links?: Record<string, string> } = {}) {
  const users = new Map(Object.entries(initial.users ?? {})); // id -> email
  const links = new Map(Object.entries(initial.links ?? {})); // provider:subject -> userId
  const events: string[] = [];
  let next = 1;
  const store: IdentityStore = {
    async findLinkedUserId(provider, subject) {
      return links.get(`${provider}:${subject}`) ?? null;
    },
    async userExists(userId) {
      return users.has(userId);
    },
    async findUserIdByEmail(email) {
      return [...users].find(([, e]) => e === email)?.[0] ?? null;
    },
    async userHasAnyLink(userId) {
      return [...links.values()].includes(userId);
    },
    async createUser(email) {
      // Mirrors HyperDX's unique email index.
      if ([...users.values()].includes(email)) throw new LinkConflictError();
      const id = `new-${next++}`;
      users.set(id, email);
      events.push(`create:${email}`);
      return id;
    },
    async link(identity: VerifiedIdentity, userId) {
      // Mirrors the unique userId index: one link per HyperDX user.
      const key = `${identity.provider}:${identity.subject}`;
      if ([...links].some(([other, id]) => id === userId && other !== key)) throw new LinkConflictError();
      links.set(key, userId);
      events.push(`link:${identity.subject}->${userId}`);
    },
    async unlink(provider, subject) {
      links.delete(`${provider}:${subject}`);
      events.push(`unlink:${subject}`);
    },
    async touch(_provider, subject) {
      events.push(`touch:${subject}`);
    },
  };
  return { store, events, users, links };
}

const identity: VerifiedIdentity = { provider: 'idp', subject: 's1', email: 'alice@example.com', name: 'Alice', groups: [] };

describe('resolveAccount', () => {
  it('uses an existing link', async () => {
    const { store, events } = memoryStore({ users: { u1: 'alice@example.com' }, links: { 'idp:s1': 'u1' } });
    expect(await resolveAccount(store, providerWith(), identity)).toEqual({ userId: 'u1', outcome: 'linked' });
    expect(events).toEqual(['touch:s1']);
  });

  it('links an existing user by email the first time (e.g. the break-glass password user)', async () => {
    const { store, events } = memoryStore({ users: { u1: 'alice@example.com' } });
    expect(await resolveAccount(store, providerWith(), identity)).toEqual({ userId: 'u1', outcome: 'linkedByEmail' });
    expect(events).toEqual(['link:s1->u1']);
  });

  it('creates and links a new user', async () => {
    const { store, events } = memoryStore();
    expect(await resolveAccount(store, providerWith(), identity)).toEqual({ userId: 'new-1', outcome: 'created' });
    expect(events).toEqual(['create:alice@example.com', 'link:s1->new-1']);
  });

  it('drops a stale link whose user was deleted, then resolves afresh', async () => {
    const { store, events } = memoryStore({ links: { 'idp:s1': 'gone' } });
    expect(await resolveAccount(store, providerWith(), identity)).toEqual({ userId: 'new-1', outcome: 'created' });
    expect(events[0]).toBe('unlink:s1');
  });

  it('never links by email to an account another subject already holds', async () => {
    // A recycled email, or a second provider asserting it, must not take over
    // the account that is already linked to someone.
    const { store, events } = memoryStore({ users: { u1: 'alice@example.com' }, links: { 'other:s9': 'u1' } });
    expect(await resolveAccount(store, providerWith(), identity)).toEqual({ denied: 'emailInUse' });
    expect(events).toEqual([]);
  });

  it('refuses the loser of two subjects racing to link the same account by email', async () => {
    // Both read "no link" before either writes; the unique userId index makes
    // the second write fail, and the retry then sees the winner's link.
    const { store, links } = memoryStore({ users: { u1: 'alice@example.com' } });
    const racer = (subject: string) => resolveAccount(store, providerWith(), { ...identity, subject });
    const results = await Promise.all([racer('s1'), racer('s2')]);
    expect(results).toContainEqual({ userId: 'u1', outcome: 'linkedByEmail' });
    expect(results).toContainEqual({ denied: 'emailInUse' });
    expect([...links.values()].filter((id) => id === 'u1')).toHaveLength(1);
  });

  it('lets a subject whose own concurrent login won find its link on retry', async () => {
    const { store } = memoryStore();
    const results = await Promise.all([
      resolveAccount(store, providerWith(), identity),
      resolveAccount(store, providerWith(), identity),
    ]);
    // One created the user; the other either linked to it or, having lost the
    // create race, resolved to the same account on retry.
    const ids = results.map((result) => ('userId' in result ? result.userId : 'denied'));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('new-1');
  });

  it('honours linkExistingUsersByEmail: false and createUsers: false', async () => {
    const noLink = memoryStore({ users: { u1: 'alice@example.com' } });
    expect(await resolveAccount(noLink.store, providerWith({ linkExistingUsersByEmail: false }), identity)).toEqual({
      denied: 'emailInUse',
    });
    const noCreate = memoryStore();
    expect(await resolveAccount(noCreate.store, providerWith({ createUsers: false }), identity)).toEqual({ denied: 'noAccount' });
    expect(noCreate.events).toEqual([]);
  });
});

describe('safeReturnTo', () => {
  it('accepts only same-origin relative paths', () => {
    expect(safeReturnTo('/search?q=1')).toBe('/search?q=1');
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'search', undefined, 42]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});

describe('pages', () => {
  it('escapes provider labels and links', () => {
    const html = renderChooser([{ label: '<script>x</script>', href: '/a?b="c"' }], undefined);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('/a?b=&quot;c&quot;');
    expect(html).not.toContain('email and password');
  });

  it('offers password sign-in only when allowed', () => {
    expect(renderChooser([], '/login')).toContain('Sign in with email and password');
  });

  it('explains a denial without echoing unknown reasons', () => {
    expect(renderDenied('groupNotAllowed', '/api/login/oidc')).toContain('not in a group');
    expect(renderDenied('<b>', '/api/login/oidc')).toContain('Sign-in failed.');
  });
});
