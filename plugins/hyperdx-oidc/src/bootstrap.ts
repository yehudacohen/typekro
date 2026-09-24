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
 * user's email and password (the same Secret key the CronJob reads), and a
 * registration is exempt only when its body carries exactly those. Without
 * them, the exemption is off and registration stays refused (fail closed).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** The initial user's credentials, from the deployment env. */
export interface BootstrapCredentials {
  readonly email: string;
  readonly password: string;
}

export const BOOTSTRAP_EMAIL_ENV = 'TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL';
export const BOOTSTRAP_PASSWORD_ENV = 'TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD';

/**
 * Read the bootstrap credentials from the environment. Either one missing or
 * empty means none: the exemption is then disabled.
 */
export function bootstrapCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>
): BootstrapCredentials | undefined {
  const email = env[BOOTSTRAP_EMAIL_ENV]?.trim() ?? '';
  const password = env[BOOTSTRAP_PASSWORD_ENV] ?? '';
  if (email.length === 0 || password.length === 0) return undefined;
  return { email, password };
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
 * `POST /register/password`, and its body's `email` (case-insensitive) and
 * `password` (constant time) match them. HyperDX answers every registration
 * with 409 `teamAlreadyExists` once a team exists, so even a matching request
 * can claim nothing after the bootstrap.
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
  // Both comparisons always run; the password's never short-circuits.
  const passwordMatches = secretsEqual(password, credentials.password);
  const emailMatches = email.toLowerCase() === credentials.email.toLowerCase();
  return emailMatches && passwordMatches;
}
