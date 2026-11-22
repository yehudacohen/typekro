import {
  type Account,
  decode,
  encodeAccount,
  encodeOperator,
  encodeUser,
  fmtCreds,
  type OperatorLimits,
  type User,
} from '@nats-io/jwt';
import { createAccount, createOperator, createUser, fromSeed, type KeyPair } from '@nats-io/nkeys';
import { TypeKroError } from '../../../core/errors.js';
import { byteQuantityBytes } from '../../../utils/byte-quantity.js';

/** The kind of nkey a seed belongs to. */
export type NatsSeedKind = 'operator' | 'account' | 'user';

/**
 * Per-account resource limits. Every field is required: an account never gets
 * JetStream or connections by default. Storage takes bytes or a Kubernetes
 * quantity (`'2Gi'`, `'256Mi'`); `-1` means unlimited and must be written out.
 * While the account has JetStream storage, `streams` and `consumers` must be at
 * least 1 (or -1): the server reads 0 there as unlimited.
 */
export interface NatsAccountLimits {
  /** JetStream file storage for the whole account. */
  readonly fileStorage: number | string;
  /** JetStream memory storage for the whole account. `0` turns memory streams off. */
  readonly memoryStorage: number | string;
  /** Maximum number of JetStream streams. */
  readonly streams: number;
  /** Maximum number of JetStream consumers. */
  readonly consumers: number;
  /** Maximum number of concurrent client connections. */
  readonly connections: number;
}

/** One workload's user in an account. */
export interface NatsAccountUserConfig {
  /** User name, unique in its account. */
  readonly name: string;
  /** The user's nkey seed (`SU...`), persisted by the caller. */
  readonly seed: string;
  /**
   * Subject prefix the user may publish and subscribe below. Defaults to the
   * account's prefix and must equal it or sit below it.
   */
  readonly subjectPrefix?: string;
  /**
   * Allow the JetStream API (`$JS.API.>`) and acknowledgements (`$JS.ACK.>`).
   * The API is account-wide, so a user with it can manage every stream in the
   * account. Default `true`.
   */
  readonly jetStream?: boolean;
  /** Allow replies to requests the user receives. Default `true`. */
  readonly responses?: boolean;
  /**
   * Confine the user's reply inboxes to `<inboxPrefix>.>` instead of the
   * shared `_INBOX.>`; the client must use the same custom inbox prefix. Without
   * it the user can subscribe to every inbox in the account, including other
   * users' replies.
   */
  readonly inboxPrefix?: string;
}

/** One account (the isolation unit) and its users. */
export interface NatsAccountConfig {
  /** Account name, unique across the operator. */
  readonly name: string;
  /** The account's nkey seed (`SA...`), persisted by the caller. */
  readonly seed: string;
  /** Subject prefix the account's users are confined to, such as `orders` or `team.orders`. */
  readonly subjectPrefix: string;
  readonly limits: NatsAccountLimits;
  readonly users?: readonly NatsAccountUserConfig[];
}

/** Everything needed to issue an operator, its system account and its accounts. */
export interface NatsOperatorAccountsConfig {
  /** The operator: its name and nkey seed (`SO...`). */
  readonly operator: { readonly name: string; readonly seed: string };
  /** The system account: its nkey seed (`SA...`) and name (default `SYS`). */
  readonly systemAccount: { readonly name?: string; readonly seed: string };
  readonly accounts: readonly NatsAccountConfig[];
  /**
   * The issue time written into every JWT, in seconds since the epoch or as a
   * `Date`. Keep it fixed so that issuing again from the same seeds and
   * configuration produces byte-identical JWTs, server configuration and
   * credentials.
   */
  readonly issuedAt: number | Date;
}

/** An issued user. `creds` is secret: it holds the user's seed. */
export interface NatsIssuedUser {
  readonly name: string;
  readonly publicKey: string;
  readonly jwt: string;
  /** The standard NATS credentials file (JWT and seed). Store it as a secret. */
  readonly creds: string;
}

export interface NatsIssuedAccount {
  readonly name: string;
  readonly publicKey: string;
  readonly jwt: string;
  readonly subjectPrefix: string;
  readonly users: readonly NatsIssuedUser[];
}

/** The issued operator, accounts and users, and the server configuration that trusts them. */
export interface NatsOperatorAccounts {
  readonly operator: { readonly name: string; readonly publicKey: string; readonly jwt: string };
  readonly systemAccount: {
    readonly name: string;
    readonly publicKey: string;
    readonly jwt: string;
  };
  readonly accounts: readonly NatsIssuedAccount[];
  /** Account public key to account JWT, system account first. */
  readonly resolverPreload: Readonly<Record<string, string>>;
  /**
   * A `nats.conf` fragment that turns on operator mode with the memory
   * resolver: `operator`, `system_account`, `resolver: MEMORY` and
   * `resolver_preload`. It holds only public JWTs and keys, never a seed.
   */
  readonly serverConfig: string;
}

/** Raised for invalid operator or account configuration. Never carries a seed. */
export class NatsOperatorAccountsError extends TypeKroError {
  constructor(message: string, path: string) {
    super(`NATS operator accounts: ${message} (at ${path})`, 'NATS_OPERATOR_ACCOUNTS_INVALID', {
      path,
    });
    this.name = 'NatsOperatorAccountsError';
  }
}

const SEED_PREFIX: Readonly<Record<NatsSeedKind, string>> = {
  operator: 'SO',
  account: 'SA',
  user: 'SU',
};
const PUBLIC_PREFIX: Readonly<Record<NatsSeedKind, string>> = {
  operator: 'O',
  account: 'A',
  user: 'U',
};

/**
 * Generate a new nkey seed with the official `@nats-io/nkeys` library. Persist
 * it (a secret store, never source control): every later issue must use the
 * same seed for the identity to stay the same.
 */
export function generateNatsSeed(kind: NatsSeedKind): string {
  const pair =
    kind === 'operator' ? createOperator() : kind === 'account' ? createAccount() : createUser();
  return new TextDecoder().decode(pair.getSeed());
}

/**
 * Issue an operator, its system account, accounts with required JetStream
 * and connection limits, and per-workload users confined to a subject prefix,
 * with the official `@nats-io/jwt` and `@nats-io/nkeys` libraries.
 *
 * Issuing is deterministic: the same seeds, configuration and `issuedAt` give
 * byte-identical output (Ed25519 signatures are deterministic, and the JWT ID
 * is a hash of the claims). Accounts are therefore reissued on every deploy
 * from persisted seeds rather than stored.
 */
export async function issueNatsOperatorAccounts(
  config: NatsOperatorAccountsConfig
): Promise<NatsOperatorAccounts> {
  const issuedAt = issueTime(config.issuedAt);
  if (!globalThis.crypto?.subtle) {
    throw new NatsOperatorAccountsError(
      'Web Crypto (globalThis.crypto.subtle) is required for deterministic JWT IDs',
      'issuedAt'
    );
  }
  const operatorName = requireName(config.operator.name, 'operator.name');
  const operatorKey = keyPair(config.operator.seed, 'operator', 'operator.seed');
  const systemName = requireName(config.systemAccount.name ?? 'SYS', 'systemAccount.name');
  const systemKey = keyPair(config.systemAccount.seed, 'account', 'systemAccount.seed');

  const accountNames = new Set<string>([systemName]);
  const accountKeys = new Set<string>([systemKey.getPublicKey()]);
  const accountInputs = config.accounts.map((account, index) => {
    const path = `accounts[${index}]`;
    const name = requireName(account.name, `${path}.name`);
    if (accountNames.has(name)) {
      throw new NatsOperatorAccountsError(`account name "${name}" is used twice`, `${path}.name`);
    }
    accountNames.add(name);
    const key = keyPair(account.seed, 'account', `${path}.seed`);
    if (accountKeys.has(key.getPublicKey())) {
      throw new NatsOperatorAccountsError(
        'account seed is used by another account',
        `${path}.seed`
      );
    }
    accountKeys.add(key.getPublicKey());
    const subjectPrefix = requireSubjectPrefix(account.subjectPrefix, `${path}.subjectPrefix`);
    const limits = accountLimits(account.limits, `${path}.limits`);
    const userNames = new Set<string>();
    const userKeys = new Set<string>();
    const users = (account.users ?? []).map((user, userIndex) => {
      const userPath = `${path}.users[${userIndex}]`;
      const userName = requireName(user.name, `${userPath}.name`);
      if (userNames.has(userName)) {
        throw new NatsOperatorAccountsError(
          `user name "${userName}" is used twice`,
          `${userPath}.name`
        );
      }
      userNames.add(userName);
      const userKey = keyPair(user.seed, 'user', `${userPath}.seed`);
      if (userKeys.has(userKey.getPublicKey())) {
        throw new NatsOperatorAccountsError(
          'user seed is used by another user',
          `${userPath}.seed`
        );
      }
      userKeys.add(userKey.getPublicKey());
      const userPrefix =
        user.subjectPrefix === undefined
          ? subjectPrefix
          : requireSubjectPrefix(user.subjectPrefix, `${userPath}.subjectPrefix`);
      if (userPrefix !== subjectPrefix && !userPrefix.startsWith(`${subjectPrefix}.`)) {
        throw new NatsOperatorAccountsError(
          `subject prefix "${userPrefix}" is outside the account prefix "${subjectPrefix}"`,
          `${userPath}.subjectPrefix`
        );
      }
      return {
        name: userName,
        key: userKey,
        claims: userClaims(
          userPrefix,
          user.jetStream ?? true,
          user.responses ?? true,
          user.inboxPrefix === undefined
            ? '_INBOX'
            : requireSubjectPrefix(user.inboxPrefix, `${userPath}.inboxPrefix`, true)
        ),
      };
    });
    return { name, key, subjectPrefix, limits, users };
  });

  const systemPublicKey = systemKey.getPublicKey();
  const operatorJwt = await encodeAt(issuedAt, () =>
    encodeOperator(operatorName, operatorKey, { system_account: systemPublicKey })
  );
  const systemJwt = await encodeAt(issuedAt, () =>
    encodeAccount(systemName, systemKey, { limits: systemAccountLimits() }, { signer: operatorKey })
  );
  const accounts: NatsIssuedAccount[] = [];
  for (const account of accountInputs) {
    const claims: Partial<Account> = { limits: account.limits };
    const jwt = await encodeAt(issuedAt, () =>
      encodeAccount(account.name, account.key, claims, { signer: operatorKey })
    );
    const users: NatsIssuedUser[] = [];
    for (const user of account.users) {
      const userJwt = await encodeAt(issuedAt, () =>
        encodeUser(user.name, user.key, account.key, user.claims)
      );
      users.push({
        name: user.name,
        publicKey: user.key.getPublicKey(),
        jwt: userJwt,
        creds: new TextDecoder().decode(fmtCreds(userJwt, user.key)),
      });
    }
    accounts.push({
      name: account.name,
      publicKey: account.key.getPublicKey(),
      jwt,
      subjectPrefix: account.subjectPrefix,
      users,
    });
  }

  const resolverPreload: Record<string, string> = { [systemPublicKey]: systemJwt };
  for (const account of accounts) resolverPreload[account.publicKey] = account.jwt;
  return {
    operator: { name: operatorName, publicKey: operatorKey.getPublicKey(), jwt: operatorJwt },
    systemAccount: { name: systemName, publicKey: systemPublicKey, jwt: systemJwt },
    accounts,
    resolverPreload,
    serverConfig: renderServerConfig(operatorJwt, systemPublicKey, resolverPreload),
  };
}

function renderServerConfig(
  operatorJwt: string,
  systemAccount: string,
  preload: Readonly<Record<string, string>>
): string {
  // JWTs and nkey public keys are base64url and base32: they never need
  // escaping inside a quoted nats.conf string.
  return [
    `operator: "${operatorJwt}"`,
    `system_account: "${systemAccount}"`,
    'resolver: MEMORY',
    'resolver_preload: {',
    ...Object.entries(preload).map(([publicKey, jwt]) => `  ${publicKey}: "${jwt}"`),
    '}',
    '',
  ].join('\n');
}

/**
 * Run one `@nats-io/jwt` encode with its clock fixed at `issuedAt`.
 *
 * The library stamps `iat` from `Date.now()` with no option to set it, which
 * would make every reissue differ. It reads the clock synchronously, before
 * its first `await`, so the clock is replaced only for that synchronous part
 * and restored before anything else can run. The decoded result is checked,
 * so a library change that reads the clock later fails loudly instead of
 * silently issuing non-deterministic JWTs.
 */
async function encodeAt(issuedAt: number, encode: () => Promise<string>): Promise<string> {
  const now = Date.now;
  let pending: Promise<string>;
  Date.now = () => issuedAt * 1000;
  try {
    pending = encode();
  } finally {
    Date.now = now;
  }
  const jwt = await pending;
  if (decode(jwt).iat !== issuedAt) {
    throw new NatsOperatorAccountsError(
      'the NATS JWT library did not use the fixed issue time; JWTs would not be deterministic',
      'issuedAt'
    );
  }
  return jwt;
}

function issueTime(value: number | Date): number {
  const seconds = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new NatsOperatorAccountsError(
      'issuedAt must be a non-negative whole number of seconds or a valid Date',
      'issuedAt'
    );
  }
  return seconds;
}

function keyPair(seed: string, kind: NatsSeedKind, path: string): KeyPair {
  // Never echo the seed: errors name only the path and the expected kind.
  const invalid = () =>
    new NatsOperatorAccountsError(`expected a ${kind} nkey seed (${SEED_PREFIX[kind]}...)`, path);
  if (typeof seed !== 'string' || !seed.startsWith(SEED_PREFIX[kind])) throw invalid();
  let pair: KeyPair;
  try {
    pair = fromSeed(new TextEncoder().encode(seed));
  } catch {
    throw invalid();
  }
  if (!pair.getPublicKey().startsWith(PUBLIC_PREFIX[kind])) throw invalid();
  return pair;
}

function requireName(name: string, path: string): string {
  if (typeof name !== 'string' || name.trim() === '' || name !== name.trim()) {
    throw new NatsOperatorAccountsError(
      'name must be a non-empty string without surrounding spaces',
      path
    );
  }
  return name;
}

const SUBJECT_TOKEN = /^[^\s.*>]+$/u;

function requireSubjectPrefix(prefix: string, path: string, inbox = false): string {
  const tokens = typeof prefix === 'string' ? prefix.split('.') : [];
  if (tokens.length === 0 || !tokens.every((token) => SUBJECT_TOKEN.test(token))) {
    throw new NatsOperatorAccountsError(
      'subject prefix must be dot-separated tokens with no spaces or wildcards',
      path
    );
  }
  if (prefix.startsWith('$') || (!inbox && (prefix === '_INBOX' || prefix.startsWith('_INBOX.')))) {
    throw new NatsOperatorAccountsError(`subject prefix "${prefix}" is reserved by NATS`, path);
  }
  return prefix;
}

function accountLimits(limits: NatsAccountLimits, path: string): Partial<OperatorLimits> {
  if (!limits || typeof limits !== 'object') {
    throw new NatsOperatorAccountsError('limits are required', path);
  }
  const diskStorage = storageBytes(limits.fileStorage, `${path}.fileStorage`);
  const memoryStorage = storageBytes(limits.memoryStorage, `${path}.memoryStorage`);
  // JetStream is on when the account has any storage. The server reads a
  // stream or consumer limit of 0 as unlimited, so it cannot mean "none" then.
  const jetStream = diskStorage !== 0 || memoryStorage !== 0;
  return {
    subs: -1,
    data: -1,
    payload: -1,
    imports: -1,
    exports: -1,
    wildcards: true,
    conn: count(limits.connections, `${path}.connections`),
    // Leaf node connections are not part of this model; an account that
    // needs them is configured explicitly.
    leaf: 0,
    disallow_bearer: true,
    disk_storage: diskStorage,
    mem_storage: memoryStorage,
    streams: count(limits.streams, `${path}.streams`, jetStream),
    consumer: count(limits.consumers, `${path}.consumers`, jetStream),
  };
}

/** The system account carries server events only: no JetStream. */
function systemAccountLimits(): Partial<OperatorLimits> {
  return {
    subs: -1,
    data: -1,
    payload: -1,
    imports: -1,
    exports: -1,
    wildcards: true,
    conn: -1,
    leaf: -1,
  };
}

function userClaims(
  prefix: string,
  jetStream: boolean,
  responses: boolean,
  inboxPrefix: string
): Partial<User> {
  const subjects = [prefix, `${prefix}.>`];
  // $JS.FC answers push-consumer flow control; $JS.ACK acknowledges messages.
  const jetStreamPublish = jetStream ? ['$JS.API.>', '$JS.ACK.>', '$JS.FC.>'] : [];
  return {
    pub: { allow: [...subjects, ...jetStreamPublish], deny: [] },
    sub: { allow: [...subjects, `${inboxPrefix}.>`], deny: [] },
    ...(responses ? { resp: { max: 1, ttl: 0 } } : {}),
    bearer_token: false,
  };
}

function count(value: number, path: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new NatsOperatorAccountsError('must be a whole number, or -1 for unlimited', path);
  }
  if (positive && value === 0) {
    throw new NatsOperatorAccountsError(
      'must be at least 1, or -1 for unlimited, while the account has JetStream storage (the server reads 0 as unlimited)',
      path
    );
  }
  return value;
}

function storageBytes(value: number | string, path: string): number {
  if (typeof value === 'number') return count(value, path);
  const bytes = typeof value === 'string' ? byteQuantityBytes(value) : undefined;
  if (bytes === undefined) {
    throw new NatsOperatorAccountsError(
      'storage must be bytes, -1 for unlimited, or a quantity such as "2Gi"',
      path
    );
  }
  return bytes;
}
