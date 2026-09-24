import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOTSTRAP_EMAIL_ENV,
  BOOTSTRAP_PASSWORD_FILE_ENV,
  bootstrapCredentialsFromEnv,
  isBootstrapRegistration,
  readBootstrapPassword,
} from '../../../plugins/hyperdx-oidc/src/bootstrap.js';

const dir = mkdtempSync(join(tmpdir(), 'typekro-hdx-bootstrap-'));
const passwordFile = join(dir, 'password');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Replace the file atomically, as the kubelet swaps a Secret volume's contents. */
function setPassword(value: string | undefined) {
  if (value === undefined) {
    rmSync(passwordFile, { force: true });
    return;
  }
  const next = join(dir, 'password.next');
  writeFileSync(next, value);
  renameSync(next, passwordFile);
}

const PASSWORD = 'Initial-Passw0rd!';
const bootstrap = { email: 'ops@example.com', passwordFile };
const initialUserOwned = { createTeam: false, bootstrap };

const register = (body: unknown, overrides: Partial<{ method: string; path: string }> = {}) => ({
  method: 'POST',
  path: '/register/password',
  body,
  ...overrides,
});
const credentials = (password: string, email = bootstrap.email) => ({ email, password, confirmPassword: password });

beforeEach(() => setPassword(PASSWORD));

describe('bootstrap registration exemption', () => {
  it("admits the initial user's own registration", () => {
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(true);
    // Email matches case-insensitively; path matches however Express would.
    expect(isBootstrapRegistration(register(credentials(PASSWORD, 'Ops@Example.COM')), initialUserOwned)).toBe(true);
    expect(isBootstrapRegistration(register(credentials(PASSWORD), { path: '/Register/Password/' }), initialUserOwned)).toBe(true);
  });

  it('refuses any other registration', () => {
    const cases: unknown[] = [
      { email: 'attacker@example.com', password: PASSWORD },
      { email: bootstrap.email, password: 'wrong' },
      { email: bootstrap.email, password: `${PASSWORD}x` },
      { email: bootstrap.email, password: '' },
      { email: bootstrap.email },
      { email: [bootstrap.email], password: PASSWORD },
      { email: bootstrap.email, password: [PASSWORD] },
      undefined,
      null,
      'email=ops@example.com',
    ];
    for (const body of cases) {
      expect([body, isBootstrapRegistration(register(body), initialUserOwned)]).toEqual([body, false]);
    }
  });

  it('applies only to POST /register/password', () => {
    const body = credentials(PASSWORD);
    expect(isBootstrapRegistration(register(body, { method: 'GET' }), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(body, { path: '/login/password' }), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(body, { path: '/team/setup/abc' }), initialUserOwned)).toBe(false);
  });

  it('fails closed without bootstrap credentials', () => {
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), { createTeam: false })).toBe(false);
  });

  it('never applies when the plugin may create the team itself', () => {
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), { createTeam: true, bootstrap })).toBe(false);
  });
});

describe('bootstrap password file, read on every attempt', () => {
  it('refuses while the file is absent, and admits once it appears (no restart)', () => {
    setPassword(undefined);
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(false);
    setPassword(PASSWORD);
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(true);
  });

  it('follows a rotation: the old password is refused, the new one admitted', () => {
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(true);
    setPassword('Rotated-Passw0rd!');
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(credentials('Rotated-Passw0rd!')), initialUserOwned)).toBe(true);
  });

  it('refuses an empty file, and a password that matches only an empty file', () => {
    setPassword('');
    expect(isBootstrapRegistration(register(credentials('')), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(false);
  });

  it('refuses when the path is a directory or unreadable, without throwing', () => {
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), { createTeam: false, bootstrap: { ...bootstrap, passwordFile: dir } })).toBe(
      false
    );
    if (process.getuid?.() !== 0) {
      chmodSync(passwordFile, 0o000);
      try {
        expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(false);
      } finally {
        chmodSync(passwordFile, 0o644);
      }
    }
  });

  it('compares the exact bytes, as the CronJob sends them: a trailing newline is part of the password', () => {
    // A Secret volume file holds exactly the Secret's bytes, and the CronJob's
    // secretKeyRef env var carries the same bytes untrimmed.
    setPassword(`${PASSWORD}\n`);
    expect(isBootstrapRegistration(register(credentials(PASSWORD)), initialUserOwned)).toBe(false);
    expect(isBootstrapRegistration(register(credentials(`${PASSWORD}\n`)), initialUserOwned)).toBe(true);
    setPassword(' spaced password ');
    expect(isBootstrapRegistration(register(credentials(' spaced password ')), initialUserOwned)).toBe(true);
    expect(isBootstrapRegistration(register(credentials('spaced password')), initialUserOwned)).toBe(false);
  });

  it('reads the password as UTF-8, or nothing', () => {
    setPassword('pässwörd-✓');
    expect(readBootstrapPassword(passwordFile)).toBe('pässwörd-✓');
    expect(isBootstrapRegistration(register(credentials('pässwörd-✓')), initialUserOwned)).toBe(true);
    setPassword(undefined);
    expect(readBootstrapPassword(passwordFile)).toBeUndefined();
  });
});

describe('bootstrap credentials from the environment', () => {
  it('reads the email and the password file path, trimmed; the file need not exist yet', () => {
    expect(
      bootstrapCredentialsFromEnv({
        [BOOTSTRAP_EMAIL_ENV]: ' ops@example.com ',
        [BOOTSTRAP_PASSWORD_FILE_ENV]: ' /does/not/exist/yet ',
      })
    ).toEqual({ email: 'ops@example.com', passwordFile: '/does/not/exist/yet' });
  });

  it('yields none when either is missing or empty (the exemption is then off)', () => {
    expect(bootstrapCredentialsFromEnv({})).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: 'ops@example.com' })).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_PASSWORD_FILE_ENV]: passwordFile })).toBeUndefined();
    expect(
      bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: 'ops@example.com', [BOOTSTRAP_PASSWORD_FILE_ENV]: ' ' })
    ).toBeUndefined();
    expect(bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: '  ', [BOOTSTRAP_PASSWORD_FILE_ENV]: passwordFile })).toBeUndefined();
  });

  it('no longer reads a password from the environment', () => {
    expect(
      bootstrapCredentialsFromEnv({ [BOOTSTRAP_EMAIL_ENV]: 'ops@example.com', TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD: 'pw' })
    ).toBeUndefined();
  });
});
