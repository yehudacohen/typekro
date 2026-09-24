/**
 * The one password registration `passwordLogin: false` still lets through.
 *
 * When TypeKro's `initialUser` owns the instance, its CronJob claims HyperDX
 * through HyperDX's own first-run registration (`POST /register/password`).
 * With the configuration OIDC-only from the start, that registration must
 * still work, but only for the initial user: until a team exists, anyone who
 * can reach the API could otherwise register their own account and claim the
 * instance, and the CronJob would then read HyperDX's 409 as "already done".
 *
 * So the exemption is authenticated. The wiring hands the plugin the initial
 * user's email and the path of a file holding its password (the same Secret
 * key the CronJob reads, projected into the pod as a file), and a
 * registration is exempt only when its body carries exactly those.
 *
 * The password is read from the file on every registration attempt, never
 * cached. The initialUser contract is one-shot and recoverable: the key may be
 * added to the Secret after HyperDX starts, or rotated before the bootstrap
 * has registered, and each CronJob run picks up the current value. A Secret
 * volume follows the Secret (a Secret-backed env var would be frozen for the
 * pod's lifetime), so reading the file each time keeps the plugin in step with
 * the CronJob. A missing, unreadable or empty file refuses that attempt (fail
 * closed); the next attempt reads it again.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Where the initial user's credentials come from. */
export interface BootstrapCredentials {
  readonly email: string;
  /** File holding the password, re-read on every registration attempt. */
  readonly passwordFile: string;
}

export const BOOTSTRAP_EMAIL_ENV = 'TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL';
export const BOOTSTRAP_PASSWORD_FILE_ENV = 'TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE';

/**
 * Read the bootstrap configuration from the environment. Either one missing
 * or empty means none: the exemption is then disabled. The password file
 * itself may not exist yet; that is checked per attempt.
 */
export function bootstrapCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>
): BootstrapCredentials | undefined {
  const email = env[BOOTSTRAP_EMAIL_ENV]?.trim() ?? '';
  const passwordFile = env[BOOTSTRAP_PASSWORD_FILE_ENV]?.trim() ?? '';
  if (email.length === 0 || passwordFile.length === 0) return undefined;
  return { email, passwordFile };
}

/**
 * The initial user's password as it is right now, or `undefined` when the file
 * is missing, unreadable or empty.
 *
 * The content is used exactly as stored, not trimmed: a Secret volume file
 * holds exactly the Secret's bytes, and the CronJob sends the same bytes
 * (a `secretKeyRef` env var, used as is), so a trailing newline in the Secret
 * is part of the password on both sides.
 */
export function readBootstrapPassword(passwordFile: string): string | undefined {
  let password: string;
  try {
    password = readFileSync(passwordFile, 'utf8');
  } catch {
    // Absent (the key isn't in the Secret yet) or unreadable: refuse this attempt.
    return undefined;
  }
  return password.length === 0 ? undefined : password;
}

/** A request path as Express matches it: case-insensitive, trailing slashes ignored. */
export function normalizeRoutePath(path: string): string {
  return path.toLowerCase().replace(/\/+$/, '');
}

/**
 * Compare two secrets in constant time. Both are hashed first, so the buffers
 * handed to `timingSafeEqual` always have the same length and a length
 * mismatch takes as long as any other mismatch.
 */
function secretsEqual(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** The parts of a request the decision reads. `body` is parsed by Express before the root router runs. */
export interface RegistrationRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/**
 * Whether a request is the initial user's own first-run registration, and so
 * exempt from `passwordLogin: false`.
 *
 * True only when the plugin may not create the team itself (`createTeam`
 * off), bootstrap credentials are configured, the request is
 * `POST /register/password`, the password file currently holds a password,
 * and the body's `email` (case-insensitive) and `password` (constant time)
 * match. The file is read only for a request that got that far, so ordinary
 * traffic never touches it. HyperDX answers every registration with 409
 * `teamAlreadyExists` once a team exists, so even a matching request can
 * claim nothing after the bootstrap.
 */
export function isBootstrapRegistration(
  req: RegistrationRequest,
  options: { readonly createTeam: boolean; readonly bootstrap?: BootstrapCredentials }
): boolean {
  const credentials = options.bootstrap;
  if (options.createTeam || credentials === undefined) return false;
  if (req.method !== 'POST' || normalizeRoutePath(req.path) !== '/register/password') return false;
  const body = req.body;
  if (typeof body !== 'object' || body === null) return false;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') return false;
  const expected = readBootstrapPassword(credentials.passwordFile);
  if (expected === undefined) return false;
  // Both comparisons always run; the password's never short-circuits.
  const passwordMatches = secretsEqual(password, expected);
  const emailMatches = email.toLowerCase() === credentials.email.toLowerCase();
  return emailMatches && passwordMatches;
}
