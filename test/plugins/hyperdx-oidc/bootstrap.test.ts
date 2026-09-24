import { describe, expect, it } from 'bun:test';
import {
  BOOTSTRAP_EMAIL_ENV,
  BOOTSTRAP_PASSWORD_ENV,
  bootstrapCredentialsFromEnv,
  isBootstrapRegistration,
} from '../../../plugins/hyperdx-oidc/src/bootstrap.js';

const bootstrap = { email: 'ops@example.com', password: 'Initial-Passw0rd!' };
const initialUserOwned = { createTeam: false, bootstrap };

const register = (body: unknown, overrides: Partial<{ method: string; path: string }> = {}) => ({
  method: 'POST',
  path: '/register/password',
  body,
  ...overrides,
});

describe('bootstrap registration exemption', () => {
  it("admits the initial user's own registration", () => {
    const body = { email: bootstrap.email, password: bootstrap.password, confirmPassword: bootstrap.password };
    expect(isBootstrapRegistration(register(body), initialUserOwned)).toBe(true);
    // Email matches case-insensitively; path matches however Express would.
    expect(isBootstrapRegistration(register({ ...body, email: 'Ops@Example.COM' }), initialUserOwned)).toBe(true);
    expect(isBootstrapRegistration(register(body, { path: '/Register/Password/' }), initialUserOwned)).toBe(true);
  });

  it('refuses any other registration', () => {
    const cases: unknown[] = [
      { email: 'attacker@example.com', password: bootstrap.password },
      { email: bootstrap.email, password: 'wrong' },
      { email: bootstrap.email, password: `${bootstrap.password}x` },
      { email: bootstrap.email, password: '' },
      { email: bootstrap.email },
      { email: [bootstrap.email], password: bootstrap.password },
      { email: bootstrap.email, password: [bootstrap.password] },
      undefined,
      null,
      'email=ops@example.com',
    ];
    for (const body of cases) {
      expect([body, isBootstrapRegistration(register(body), initialUserOwned)]).toEqual([body, false]);
    }
  });

  it('applies only to POST /register/password', () => {
    const body = { email: bootstrap.email, password: bootstrap.password };
    expect(isBootstrapRegistration(register(body, { method: 'GET' }), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(body, { path: '/login/password' }), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(body, { path: '/team/setup/abc' }), initialUserOwned)).toBe(false);
  });

  it('fails closed without bootstrap credentials', () => {
    const body = { email: bootstrap.email, password: bootstrap.password };
    expect(isBootstrapRegistration(register(body), { createTeam: false })).toBe(false);
  });

  it('never applies when the plugin may create the team itself', () => {
    const body = { email: bootstrap.email, password: bootstrap.password };
    expect(isBootstrapRegistration(register(body), { createTeam: true, bootstrap })).toBe(false);
  });
});

describe('bootstrap credentials from the environment', () => {
  it('reads both, trimming only the email', () => {
    expect(
      bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: ' ops@example.com ', [BOOTSTRAP_PASSWORD_ENV]: ' pw ' })
    ).toEqual({ email: 'ops@example.com', password: ' pw ' });
  });

  it('yields none when either is missing or empty (the exemption is then off)', () => {
    expect(bootstrapCredentialsFromEnv({})).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: 'ops@example.com' })).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_PASSWORD_ENV]: 'pw' })).toBeUndefined();
    expect(
      bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: 'ops@example.com', [BOOTSTRAP_PASSWORD_ENV]: '' })
    ).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: '  ', [BOOTSTRAP_PASSWORD_ENV]: 'pw' })).toBeUndefined();
  });
});
