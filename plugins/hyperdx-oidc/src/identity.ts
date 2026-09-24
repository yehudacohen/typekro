/**
 * From validated ID-token claims to a HyperDX account.
 *
 * Two steps, both free of HyperDX and I/O specifics so they can be tested in
 * isolation:
 *
 * 1. {@link evaluateClaims}: does this provider let this identity in at all
 *    (email present and verified, group and email-domain rules)?
 * 2. {@link resolveAccount}: which HyperDX user is it — an existing link, an
 *    existing user with the same email, or a new user?
 *
 * Accounts are linked by the provider's stable subject (`sub`), not by email:
 * an email can be reassigned or asserted by a second provider, a (provider,
 * subject) pair cannot. Email is only used to find an existing user the first
 * time a subject is seen, and only once the provider's own rules have passed.
 */

import type { OidcProviderConfig } from './config.js';

/** An identity that passed the provider's rules. */
export interface VerifiedIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly name: string;
  readonly groups: readonly string[];
}

export type DenialReason =
  | 'subjectMissing'
  | 'emailMissing'
  | 'emailNotVerified'
  | 'groupNotAllowed'
  | 'emailDomainNotAllowed'
  | 'noAccount';

export type ClaimsDecision =
  | { readonly allowed: true; readonly identity: VerifiedIdentity }
  | { readonly allowed: false; readonly reason: DenialReason };

/** Normalize a groups claim: an array of strings, or a single string. */
export function normalizeGroups(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function isVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Decide whether a provider admits the identity in `claims`.
 *
 * Every rule that is SET must pass: with both `allow.groups` and
 * `allow.emailDomains`, the user needs a matching group AND a matching email
 * domain. Config validation guarantees at least one rule is set.
 */
export function evaluateClaims(
  provider: OidcProviderConfig,
  claims: Readonly<Record<string, unknown>>
): ClaimsDecision {
  const subject = claims.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    return { allowed: false, reason: 'subjectMissing' };
  }

  const rawEmail = claims[provider.claims.email];
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return { allowed: false, reason: 'emailMissing' };
  if (provider.requireVerifiedEmail && !isVerified(claims.email_verified)) {
    return { allowed: false, reason: 'emailNotVerified' };
  }

  const groups = normalizeGroups(claims[provider.claims.groups]);
  if (provider.allow.groups.length > 0 && !groups.some((group) => provider.allow.groups.includes(group))) {
    return { allowed: false, reason: 'groupNotAllowed' };
  }
  const domain = email.slice(at + 1);
  if (provider.allow.emailDomains.length > 0 && !provider.allow.emailDomains.includes(domain)) {
    return { allowed: false, reason: 'emailDomainNotAllowed' };
  }

  const rawName = claims[provider.claims.name];
  return {
    allowed: true,
    identity: {
      provider: provider.id,
      subject,
      email,
      name: typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : email,
      groups,
    },
  };
}

/** The account operations {@link resolveAccount} needs. */
export interface IdentityStore {
  /** The HyperDX user id linked to (provider, subject), if any. */
  findLinkedUserId(provider: string, subject: string): Promise<string | null>;
  /** Whether a HyperDX user with this id still exists. */
  userExists(userId: string): Promise<boolean>;
  /** The HyperDX user id with this (lowercased) email, if any. */
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Create a HyperDX user in the team new users join; returns its id. */
  createUser(email: string, name: string): Promise<string>;
  /** Link (provider, subject) to a user, replacing a stale link. */
  link(identity: VerifiedIdentity, userId: string): Promise<void>;
  /** Drop a link whose user no longer exists. */
  unlink(provider: string, subject: string): Promise<void>;
  /** Record a successful login on an existing link. */
  touch(provider: string, subject: string): Promise<void>;
}

export type AccountResolution =
  | { readonly userId: string; readonly outcome: 'linked' | 'linkedByEmail' | 'created' }
  | { readonly denied: 'noAccount' };

/**
 * Find or create the HyperDX user for an admitted identity.
 *
 * Order: an existing (provider, subject) link; otherwise, when the provider
 * allows it, an existing user with the same email (e.g. the break-glass
 * password user), which is then linked; otherwise a new user, when the
 * provider allows creating users.
 */
export async function resolveAccount(
  store: IdentityStore,
  provider: OidcProviderConfig,
  identity: VerifiedIdentity
): Promise<AccountResolution> {
  const linked = await store.findLinkedUserId(identity.provider, identity.subject);
  if (linked !== null) {
    if (await store.userExists(linked)) {
      await store.touch(identity.provider, identity.subject);
      return { userId: linked, outcome: 'linked' };
    }
    // The user was deleted in HyperDX; the link is stale.
    await store.unlink(identity.provider, identity.subject);
  }

  if (provider.linkExistingUsersByEmail) {
    const existing = await store.findUserIdByEmail(identity.email);
    if (existing !== null) {
      await store.link(identity, existing);
      return { userId: existing, outcome: 'linkedByEmail' };
    }
  }

  if (!provider.createUsers) return { denied: 'noAccount' };
  const created = await store.createUser(identity.email, identity.name);
  await store.link(identity, created);
  return { userId: created, outcome: 'created' };
}
