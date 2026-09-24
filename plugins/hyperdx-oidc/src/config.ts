/**
 * Runtime configuration for the HyperDX OIDC plugin.
 *
 * The configuration is a JSON document read from a file (a mounted Kubernetes
 * Secret, in the TypeKro wiring) and RE-READ while the process runs, so
 * providers can be added, changed or removed without restarting HyperDX. It
 * carries client secrets, which is why it lives in a Secret rather than a
 * ConfigMap.
 *
 * Validation is hand-written rather than schema-library based on purpose: the
 * plugin is bundled into a single file that ships inside a ConfigMap, and every
 * dependency is size it pays for on every HyperDX pod.
 */

/** Claim names to read from the ID token, per provider. */
export interface OidcClaimNames {
  /** Claim holding the user's email. Default `email`. */
  readonly email: string;
  /** Claim holding group or role names used by `allow.groups`. Default `groups`. */
  readonly groups: string;
  /** Claim holding the display name. Default `name`. */
  readonly name: string;
}

/** Who a provider lets in. At least one rule must be set. */
export interface OidcAllowRules {
  /** Any-of match against the groups claim. */
  readonly groups: readonly string[];
  /** Any-of match against the email's domain (case-insensitive). */
  readonly emailDomains: readonly string[];
}

export interface OidcProviderConfig {
  /** URL-safe id: the route segment and the Passport strategy suffix. */
  readonly id: string;
  /** Label on the provider chooser page. */
  readonly displayName: string;
  /** Issuer identifier; metadata is discovered from `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  readonly scopes: readonly string[];
  readonly claims: OidcClaimNames;
  readonly allow: OidcAllowRules;
  /**
   * Refuse an ID token whose `email_verified` is not true. Default true. Turn
   * off only for providers that never send the claim but do own the email
   * (Entra ID); pair that with `allow.emailDomains`.
   */
  readonly requireVerifiedEmail: boolean;
  /**
   * On a subject's first login, link an existing HyperDX user with the same
   * email — only a user no provider has linked yet (e.g. the password-only
   * break-glass account). Default: on when `requireVerifiedEmail` is on, off
   * otherwise; turning it on without verified emails is refused, because an
   * unverified email is just a claim.
   */
  readonly linkExistingUsersByEmail: boolean;
  /** Create a HyperDX user on first login. Default true. */
  readonly createUsers: boolean;
}

export interface OidcPluginConfig {
  readonly providers: readonly OidcProviderConfig[];
  /** Whether HyperDX's own password login stays available. Default true. */
  readonly passwordLogin: boolean;
  /** OIDC sessions older than this are logged out and must re-authenticate. 0 = never. */
  readonly maxSessionAgeMs: number;
  /**
   * External base URL the browser reaches HyperDX on, used to build callback
   * URLs. Default: HyperDX's own `FRONTEND_URL`.
   */
  readonly redirectBaseUrl?: string;
  /** Path prefix under which the UI proxies the API. Default `/api`. */
  readonly apiPathPrefix: string;
  /** Team id new users join when more than one team exists. */
  readonly teamId?: string;
  /** Accept plain-http issuers and callbacks. Tests against a local mock provider only. */
  readonly allowInsecureHttp: boolean;
}

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DURATION = /^(\d+)\s*(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse `12h`, `30m`, `7d`, `90s`, or a bare number of seconds. */
export function parseDuration(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value * 1000;
  if (typeof value === 'string') {
    const match = DURATION.exec(value.trim());
    if (match) return Number(match[1]) * (UNIT_MS[match[2] as string] as number);
  }
  throw new OidcConfigError(
    `${field} must be a duration like "12h", "30m" or "7d", or a number of seconds (got ${JSON.stringify(value)})`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OidcConfigError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
  fallback: string
): string {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OidcConfigError(`${where}.${key} must be a non-empty string when set`);
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  where: string,
  fallback: boolean
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new OidcConfigError(`${where}.${key} must be a boolean`);
  return value;
}

function stringList(value: unknown, where: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new OidcConfigError(`${where} must be an array of non-empty strings`);
  }
  return value as string[];
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new OidcConfigError(
      `${where} has unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
        `allowed: ${allowed.join(', ')}`
    );
  }
}

function parseHttpsUrl(value: string, where: string, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigError(`${where} must be an absolute URL (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new OidcConfigError(`${where} must use https (got ${JSON.stringify(value)})`);
  }
  return value.replace(/\/+$/, '');
}

const PROVIDER_KEYS = [
  'id',
  'displayName',
  'issuer',
  'clientId',
  'clientSecret',
  'tokenEndpointAuthMethod',
  'scopes',
  'claims',
  'allow',
  'requireVerifiedEmail',
  'linkExistingUsersByEmail',
  'createUsers',
] as const;

function parseProvider(raw: unknown, index: number, allowInsecure: boolean): OidcProviderConfig {
  const where = `providers[${index}]`;
  if (!isRecord(raw)) throw new OidcConfigError(`${where} must be an object`);
  rejectUnknownKeys(raw, PROVIDER_KEYS, where);

  const id = requireString(raw, 'id', where);
  if (!PROVIDER_ID.test(id)) {
    throw new OidcConfigError(
      `${where}.id must be lowercase letters, digits and dashes, starting with a letter or digit (got ${JSON.stringify(id)})`
    );
  }

  const authMethod = raw.tokenEndpointAuthMethod ?? 'client_secret_basic';
  if (authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post') {
    throw new OidcConfigError(
      `${where}.tokenEndpointAuthMethod must be "client_secret_basic" or "client_secret_post"`
    );
  }

  const scopes = raw.scopes === undefined ? ['openid', 'email', 'profile'] : stringList(raw.scopes, `${where}.scopes`);
  if (!scopes.includes('openid')) throw new OidcConfigError(`${where}.scopes must include "openid"`);

  const claimsRaw = raw.claims ?? {};
  if (!isRecord(claimsRaw)) throw new OidcConfigError(`${where}.claims must be an object`);
  rejectUnknownKeys(claimsRaw, ['email', 'groups', 'name'], `${where}.claims`);
  const claims: OidcClaimNames = {
    email: optionalString(claimsRaw, 'email', `${where}.claims`, 'email'),
    groups: optionalString(claimsRaw, 'groups', `${where}.claims`, 'groups'),
    name: optionalString(claimsRaw, 'name', `${where}.claims`, 'name'),
  };

  if (!isRecord(raw.allow)) {
    throw new OidcConfigError(
      `${where}.allow is required: set allow.groups and/or allow.emailDomains. Without a rule, ` +
        'every account the provider can authenticate would get into HyperDX.'
    );
  }
  rejectUnknownKeys(raw.allow, ['groups', 'emailDomains'], `${where}.allow`);
  const allow: OidcAllowRules = {
    groups: stringList(raw.allow.groups, `${where}.allow.groups`),
    emailDomains: stringList(raw.allow.emailDomains, `${where}.allow.emailDomains`).map((domain) =>
      domain.toLowerCase().replace(/^@/, '')
    ),
  };
  if (allow.groups.length === 0 && allow.emailDomains.length === 0) {
    throw new OidcConfigError(
      `${where}.allow must set at least one of groups or emailDomains; an empty rule would ` +
        'admit every account the provider can authenticate.'
    );
  }

  const requireVerifiedEmail = optionalBoolean(raw, 'requireVerifiedEmail', where, true);
  const linkExistingUsersByEmail = optionalBoolean(raw, 'linkExistingUsersByEmail', where, requireVerifiedEmail);
  if (linkExistingUsersByEmail && !requireVerifiedEmail) {
    throw new OidcConfigError(
      `${where}.linkExistingUsersByEmail cannot be true when requireVerifiedEmail is false: an unverified ` +
        'email is only a claim, so linking by it would let anyone who can set their email at the provider ' +
        'take over the HyperDX account that has it.'
    );
  }

  return {
    id,
    displayName: optionalString(raw, 'displayName', where, id),
    issuer: parseHttpsUrl(requireString(raw, 'issuer', where), `${where}.issuer`, allowInsecure),
    clientId: requireString(raw, 'clientId', where),
    clientSecret: requireString(raw, 'clientSecret', where),
    tokenEndpointAuthMethod: authMethod,
    scopes,
    claims,
    allow,
    requireVerifiedEmail,
    linkExistingUsersByEmail,
    createUsers: optionalBoolean(raw, 'createUsers', where, true),
  };
}

const TOP_LEVEL_KEYS = [
  'providers',
  'passwordLogin',
  'maxSessionAge',
  'redirectBaseUrl',
  'apiPathPrefix',
  'teamId',
  'allowInsecureHttp',
] as const;

/**
 * Parse and validate the plugin configuration document.
 *
 * @throws OidcConfigError with a message naming the offending field.
 */
export function parseOidcPluginConfig(text: string): OidcPluginConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // Never echo the parser's message: it can quote source text, and the
    // source contains client secrets. Report the position only.
    const position = /position (\d+)/.exec((error as Error).message)?.[1];
    throw new OidcConfigError(
      `configuration is not valid JSON${position === undefined ? '' : ` (near character ${position})`}`
    );
  }
  if (!isRecord(raw)) throw new OidcConfigError('configuration must be a JSON object');
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, 'configuration');

  // Plain-http issuers and callbacks are refused unless explicitly allowed —
  // only ever useful for tests against a local mock provider.
  const allowInsecure = optionalBoolean(raw, 'allowInsecureHttp', 'configuration', false);

  if (!Array.isArray(raw.providers)) throw new OidcConfigError('configuration.providers must be an array');
  const providers = raw.providers.map((provider, index) => parseProvider(provider, index, allowInsecure));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new OidcConfigError(`provider id ${JSON.stringify(provider.id)} is used twice`);
    ids.add(provider.id);
  }

  const apiPathPrefix = optionalString(raw, 'apiPathPrefix', 'configuration', '/api');
  if (!apiPathPrefix.startsWith('/')) throw new OidcConfigError('configuration.apiPathPrefix must start with "/"');

  const teamId = raw.teamId === undefined ? undefined : requireString(raw, 'teamId', 'configuration');
  const redirectBaseUrl =
    raw.redirectBaseUrl === undefined
      ? undefined
      : parseHttpsUrl(requireString(raw, 'redirectBaseUrl', 'configuration'), 'configuration.redirectBaseUrl', allowInsecure);

  return {
    providers,
    passwordLogin: optionalBoolean(raw, 'passwordLogin', 'configuration', true),
    maxSessionAgeMs:
      raw.maxSessionAge === undefined ? 12 * 3_600_000 : parseDuration(raw.maxSessionAge, 'configuration.maxSessionAge'),
    apiPathPrefix: apiPathPrefix.replace(/\/+$/, ''),
    ...(redirectBaseUrl !== undefined && { redirectBaseUrl }),
    ...(teamId !== undefined && { teamId }),
    allowInsecureHttp: allowInsecure,
  };
}
