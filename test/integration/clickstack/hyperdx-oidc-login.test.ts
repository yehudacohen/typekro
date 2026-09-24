/**
 * HyperDX OIDC plugin against the REAL HyperDX image (#241).
 *
 * The plugin hooks HyperDX internals — its Passport instance, root router and
 * user/team models — so unit tests cannot prove it works. This suite runs the
 * published `hyperdx` image with the bundled plugin exactly as TypeKro ships it
 * (`NODE_OPTIONS=--require`, configuration file mounted as a directory),
 * against MongoDB and a mock OIDC provider, and drives the sign-in the way a
 * browser does: follow redirects, keep cookies, submit the provider's form.
 *
 * Docker-gated: the suite SKIPS when no Docker daemon is reachable. Set
 * REQUIRE_DOCKER_TESTS=true to make a missing daemon a failure (CI does).
 *
 * The mock provider is reached as `mockoidc:8080` from inside the Docker
 * network (discovery, token exchange) and through a published port from the
 * test (the browser leg). The browser-side client rewrites one to the other;
 * the provider derives its issuer from the Host header, so the issuer HyperDX
 * sees stays consistent.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HYPERDX_OIDC_PLUGIN_BASE64 } from '../../../src/factories/clickstack/hyperdx-oidc/plugin-bundle.generated.js';

setDefaultTimeout(300_000);

const HYPERDX_IMAGE = process.env.HYPERDX_OIDC_TEST_IMAGE ?? 'docker.hyperdx.io/hyperdx/hyperdx:2.35.0';
const MONGO_IMAGE = 'mongo:7.0';
const MOCK_IMAGE = 'ghcr.io/navikt/mock-oauth2-server:2.1.10';
const MOCK_INTERNAL = 'http://mockoidc:8080';

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}

const dockerAvailable = (() => {
  try {
    return docker(['info', '--format', '{{.ServerVersion}}']).ok;
  } catch {
    return false;
  }
})();
if (!dockerAvailable && process.env.REQUIRE_DOCKER_TESTS === 'true') {
  throw new Error('REQUIRE_DOCKER_TESTS=true but no Docker daemon is reachable');
}
const describeOrSkip = dockerAvailable ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

const suffix = `${process.pid}`;
const NETWORK = `typekro-oidc-${suffix}`;
const MONGO = `typekro-oidc-mongo-${suffix}`;
const MOCK = `typekro-oidc-mock-${suffix}`;
const HYPERDX = `typekro-oidc-hdx-${suffix}`;
/** A second HyperDX, on its own database, where a first OIDC login may create the team. */
const HYPERDX_OPEN = `typekro-oidc-hdx-open-${suffix}`;

let hdxUrl = '';
let openUrl = '';
let mockExternal = '';
let workDir = '';

const PROVIDER = {
  id: 'mock',
  displayName: 'Mock IdP',
  issuer: `${MOCK_INTERNAL}/default`,
  clientId: 'hyperdx',
  clientSecret: 'secret',
  allow: { groups: ['hyperdx-users'] },
};

function writeConfig(config: Record<string, unknown>) {
  writeFileSync(join(workDir, 'config.json'), JSON.stringify({ allowInsecureHttp: true, ...config }), { mode: 0o644 });
}

/** How many HyperDX log lines match (stdout and stderr interleave, so count rather than slice). */
function countLogMatches(pattern: RegExp): number {
  const logs = docker(['logs', HYPERDX]);
  return `${logs.stdout}\n${logs.stderr}`.split('\n').filter((line) => pattern.test(line)).length;
}

/** Wait until more HyperDX log lines match `pattern` than did before. */
async function waitForLog(pattern: RegExp, matchesBefore = 0): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (countLogMatches(pattern) > matchesBefore) return;
    await Bun.sleep(1000);
  }
  throw new Error(`HyperDX never logged ${pattern}`);
}

/** A minimal browser: per-host cookie jar, manual redirects, internal→external rewrite for the mock IdP. */
class Browser {
  private readonly jar = new Map<string, Map<string, string>>();

  private rewrite(url: string): string {
    return url.replace(MOCK_INTERNAL, mockExternal);
  }

  cookies(url: string): string {
    const cookies = this.jar.get(new URL(url).host);
    return cookies ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : '';
  }

  private store(url: string, response: Response) {
    const host = new URL(url).host;
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = (pair as string).indexOf('=');
      const cookies = this.jar.get(host) ?? new Map<string, string>();
      cookies.set((pair as string).slice(0, index), (pair as string).slice(index + 1));
      this.jar.set(host, cookies);
    }
  }

  async go(url: string, init: RequestInit = {}): Promise<{ response: Response; url: string }> {
    let current = this.rewrite(url);
    let request = init;
    for (let hop = 0; hop < 10; hop++) {
      const response = await fetch(current, {
        ...request,
        redirect: 'manual',
        headers: { ...(request.headers as Record<string, string>), cookie: this.cookies(current) },
      });
      this.store(current, response);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        current = this.rewrite(new URL(location, current).href);
        request = {};
        continue;
      }
      return { response, url: current };
    }
    throw new Error('too many redirects');
  }

  /** Start at HyperDX's login route, submit the mock IdP's form with these claims, land back on HyperDX. */
  async signIn(claims: Record<string, unknown>, provider = 'mock', base = hdxUrl) {
    const form = await this.go(`${base}/api/login/oidc/${provider}`);
    expect(form.response.status, `login form at ${form.url}`).toBe(200);
    return this.go(form.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: String(claims.sub ?? 'user'), claims: JSON.stringify(claims) }).toString(),
    });
  }

  async me(): Promise<{ status: number; body?: { id: string; email: string } }> {
    const response = await fetch(`${hdxUrl}/api/me`, { headers: { cookie: this.cookies(hdxUrl) } });
    return response.status === 200
      ? { status: 200, body: (await response.json()) as { id: string; email: string } }
      : { status: response.status };
  }
}

/** The initialUser account: what TypeKro's CronJob registers, and what the plugin is told to admit. */
const ADMIN = { email: 'admin@example.com', password: 'Break-Glass-Passw0rd!' };

const allowedClaims = (sub: string, email: string) => ({
  sub,
  email,
  email_verified: true,
  groups: ['hyperdx-users'],
  name: sub,
});

beforeAll(async () => {
  if (!dockerAvailable) return;
  workDir = mkdtempSync(join(tmpdir(), 'typekro-hdx-oidc-'));
  // mkdtemp creates the directory 0700 for the runner's user; HyperDX runs as
  // another user inside the container and must be able to read it (Docker
  // Desktop hides this; Linux CI does not).
  chmodSync(workDir, 0o755);
  writeFileSync(join(workDir, 'plugin.js'), Buffer.from(HYPERDX_OIDC_PLUGIN_BASE64, 'base64'), { mode: 0o644 });
  // OIDC-only from the very first start: initialUser must still bootstrap.
  writeConfig({ providers: [PROVIDER], passwordLogin: false });

  const hdxPort = await freePort();
  const mockPort = await freePort();
  const openPort = await freePort();
  hdxUrl = `http://localhost:${hdxPort}`;
  openUrl = `http://localhost:${openPort}`;
  mockExternal = `http://localhost:${mockPort}`;

  for (const name of [HYPERDX, HYPERDX_OPEN, MOCK, MONGO]) docker(['rm', '-f', name]);
  docker(['network', 'rm', NETWORK]);
  expect(docker(['network', 'create', NETWORK]).ok).toBe(true);
  expect(docker(['run', '-d', '--name', MONGO, '--network', NETWORK, MONGO_IMAGE]).ok).toBe(true);
  expect(
    docker([
      'run', '-d', '--name', MOCK, '--network', NETWORK, '--network-alias', 'mockoidc',
      '-p', `${mockPort}:8080`, '-e', 'JSON_CONFIG={"interactiveLogin":true}', MOCK_IMAGE,
    ]).ok
  ).toBe(true);
  const started = docker([
    'run', '-d', '--name', HYPERDX, '--network', NETWORK, '-p', `${hdxPort}:8080`,
    '-e', `MONGO_URI=mongodb://${MONGO}:27017/hyperdx`,
    '-e', `FRONTEND_URL=${hdxUrl}`,
    '-e', 'HYPERDX_APP_PORT=8080',
    // Exactly the wiring TypeKro renders (hyperdx-oidc/index.ts).
    '-e', 'NODE_OPTIONS=--require=/opt/typekro/hyperdx-oidc/plugin.js',
    '-e', 'TYPEKRO_HDX_OIDC_CONFIG=/etc/typekro/hyperdx-oidc/config.json',
    '-e', 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS=1',
    // As with initialUser: the team is claimed by a password registration,
    // never by a first OIDC login.
    '-e', 'TYPEKRO_HDX_OIDC_CREATE_TEAM=false',
    // ...and only the initialUser's own registration passes passwordLogin: false.
    '-e', `TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL=${ADMIN.email}`,
    '-e', `TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD=${ADMIN.password}`,
    '-v', `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v', `${workDir}:/etc/typekro/hyperdx-oidc:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!started.ok) throw new Error(`docker run hyperdx failed: ${started.stderr}`);
  const openStarted = docker([
    'run', '-d', '--name', HYPERDX_OPEN, '--network', NETWORK, '-p', `${openPort}:8080`,
    '-e', `MONGO_URI=mongodb://${MONGO}:27017/hyperdx-open`,
    '-e', `FRONTEND_URL=${openUrl}`,
    '-e', 'HYPERDX_APP_PORT=8080',
    '-e', 'NODE_OPTIONS=--require=/opt/typekro/hyperdx-oidc/plugin.js',
    '-e', 'TYPEKRO_HDX_OIDC_CONFIG=/etc/typekro/hyperdx-oidc/config.json',
    '-e', 'TYPEKRO_HDX_OIDC_CREATE_TEAM=true',
    '-v', `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v', `${workDir}:/etc/typekro/hyperdx-oidc:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!openStarted.ok) throw new Error(`docker run hyperdx (open) failed: ${openStarted.stderr}`);

  // The mock provider must be serving discovery before HyperDX's plugin (and
  // the browser) use it.
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${mockExternal}/default/.well-known/openid-configuration`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${hdxUrl}/api/installation`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  await waitForLog(/"plugin":"typekro-oidc","message":"installed"/);
  // Installed is not enough: the configuration must have been read and applied.
  await waitForLog(/"message":"OIDC configuration applied","providers":\["mock"\]/);
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${openUrl}/api/installation`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const logs = docker(['logs', HYPERDX_OPEN]);
    if (`${logs.stdout}\n${logs.stderr}`.includes('"message":"OIDC configuration applied","providers":["mock"]')) break;
    await Bun.sleep(1000);
  }
});

afterAll(() => {
  if (!dockerAvailable) return;
  for (const name of [HYPERDX, HYPERDX_OPEN, MOCK, MONGO]) docker(['rm', '-f', name]);
  docker(['network', 'rm', NETWORK]);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describeOrSkip('HyperDX OIDC plugin on the real HyperDX image', () => {
  it('creates exactly one team when several first logins race on a fresh instance', async () => {
    // Without initialUser, the first OIDC login claims the instance. HyperDX's
    // own check-then-create is not atomic; the plugin's claim lock must be.
    // The mock provider occasionally drops the nonce under concurrency; the
    // plugin rightly refuses that token (403), so a racer retries a 403.
    const signIn = async (n: number): Promise<number> => {
      let status = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const landed = await new Browser().signIn(allowedClaims(`racer-${n}`, `racer-${n}@example.com`), 'mock', openUrl);
        status = landed.response.status;
        if (status !== 403) break;
      }
      return status;
    };
    const statuses = await Promise.all([1, 2, 3, 4, 5].map(signIn));
    expect(statuses.every((status) => status === 200 || status === 503), `statuses: ${statuses.join(',')}`).toBe(true);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    const teams = docker([
      'exec', MONGO, 'mongosh', '--quiet', 'mongodb://localhost:27017/hyperdx-open', '--eval', 'db.teams.countDocuments()',
    ]);
    expect(teams.stdout.trim()).toBe('1');
  });

  it('does not create the team on a first OIDC login when initialUser claims the instance', async () => {
    const browser = new Browser();
    const landed = await browser.signIn(allowedClaims('early', 'early@example.com'));
    expect(landed.response.status).toBe(503);
    expect(await landed.response.text()).toContain('still being set up');
    expect((await fetch(`${hdxUrl}/api/installation`).then((r) => r.json())) as object).toEqual({ isTeamExisting: false });
  });

  const register = (account: { email: string; password: string }) =>
    fetch(`${hdxUrl}/api/register/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...account, confirmPassword: account.password }),
    });
  const hyperdxDb = (query: string) =>
    docker(['exec', MONGO, 'mongosh', '--quiet', 'mongodb://localhost:27017/hyperdx', '--eval', query]).stdout.trim();

  it('refuses a first-run registration that is not the initialUser under passwordLogin: false', async () => {
    // Until a team exists, anyone who reaches the API could otherwise claim
    // the instance, and the initialUser CronJob would read its 409 as done.
    for (const intruder of [
      { email: 'intruder@example.com', password: 'Intruder-Passw0rd!' },
      { email: 'intruder@example.com', password: ADMIN.password },
      { email: ADMIN.email, password: 'Wrong-Passw0rd!1' },
    ]) {
      const response = await register(intruder);
      expect([intruder, response.status]).toEqual([intruder, 303]);
      expect(response.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);
    }
    expect((await fetch(`${hdxUrl}/api/installation`).then((r) => r.json())) as object).toEqual({ isTeamExisting: false });
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('0');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('0');
  });

  it('lets the initialUser registration claim the instance even with passwordLogin: false', async () => {
    // What TypeKro's initialUser CronJob does, with the configuration
    // OIDC-only from the start. HyperDX closes the route itself afterwards.
    expect((await register(ADMIN)).status).toBe(200);
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('1');
    // Upstream's own answer once a team exists, even to the right credentials.
    expect((await register(ADMIN)).status).toBe(409);
    // The plugin holds the password; it must never reach the logs.
    expect(countLogMatches(/Break-Glass-Passw0rd/)).toBe(0);

    // The account exists, but password sign-in is still refused.
    const login = await fetch(`${hdxUrl}/api/login/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }).toString(),
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);
  });

  it('links the initial account by email on its first OIDC sign-in', async () => {
    // The password-only account is unclaimed, so the first OIDC login with its email links to it.
    const browser = new Browser();
    await browser.signIn(allowedClaims('admin-sub', ADMIN.email));
    expect((await browser.me()).body?.email).toBe(ADMIN.email);
  });

  it('signs in an allowed user, creating the account', async () => {
    const browser = new Browser();
    const landed = await browser.signIn(allowedClaims('alice', 'alice@example.com'));
    expect(landed.response.status).toBe(200);
    expect(landed.url).toBe(`${hdxUrl}/`);
    const me = await browser.me();
    expect(me.status).toBe(200);
    expect(me.body?.email).toBe('alice@example.com');
  });

  it('signs the same subject into the same account next time', async () => {
    const first = new Browser();
    await first.signIn(allowedClaims('alice', 'alice@example.com'));
    const second = new Browser();
    await second.signIn(allowedClaims('alice', 'alice@example.com'));
    expect((await second.me()).body?.id).toBe((await first.me()).body?.id as string);
  });

  it('refuses a user outside the allowed groups, with no session', async () => {
    const browser = new Browser();
    const landed = await browser.signIn({ ...allowedClaims('bob', 'bob@example.com'), groups: ['other'] });
    expect(landed.response.status).toBe(403);
    expect(await landed.response.text()).toContain('not in a group');
    expect((await browser.me()).status).toBe(401);
  });

  it('refuses an unverified email', async () => {
    const browser = new Browser();
    const landed = await browser.signIn({ ...allowedClaims('carol', 'carol@example.com'), email_verified: false });
    expect(landed.response.status).toBe(403);
    expect((await browser.me()).status).toBe(401);
  });

  it('gives an email to exactly one subject when several race to claim it', async () => {
    // The unique userId index, not the read-then-write, is what guarantees this.
    const racer = async (n: number) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const landed = await new Browser().signIn(allowedClaims(`shared-${n}`, 'shared@example.com'));
        const body = await landed.response.text();
        // Retry only the mock provider's occasional dropped nonce.
        if (landed.response.status !== 403 || body.includes('already belongs to another sign-in')) {
          return landed.response.status;
        }
      }
      return 0;
    };
    const statuses = await Promise.all([1, 2, 3, 4].map(racer));
    expect(statuses.filter((status) => status === 200), `statuses: ${statuses.join(',')}`).toHaveLength(1);
    expect(statuses.filter((status) => status === 403)).toHaveLength(3);
    const mongo = (query: string) =>
      docker(['exec', MONGO, 'mongosh', '--quiet', 'mongodb://localhost:27017/hyperdx', '--eval', query]).stdout.trim();
    expect(mongo("db.users.countDocuments({ email: 'shared@example.com' })")).toBe('1');
    expect(mongo("db.typekro_oidc_identities.countDocuments({ email: 'shared@example.com' })")).toBe('1');
  });

  it('refuses a Unicode look-alike of an existing email (Kelvin sign)', async () => {
    const browser = new Browser();
    const landed = await browser.signIn(allowedClaims('attacker', '\u212Alice@example.com'));
    expect(landed.response.status).toBe(403);
    expect((await browser.me()).status).toBe(401);
  });

  it('refuses a different subject asserting an email another sign-in already holds', async () => {
    const browser = new Browser();
    const landed = await browser.signIn(allowedClaims('not-alice', 'alice@example.com'));
    expect(landed.response.status).toBe(403);
    expect(await landed.response.text()).toContain('already belongs to another sign-in');
    expect((await browser.me()).status).toBe(401);
  });

  it('answers an unknown provider with 404, not 500', async () => {
    expect((await fetch(`${hdxUrl}/api/login/oidc/nope`)).status).toBe(404);
  });

  it("revokes a linked user's API access key when the provider stops admitting them", async () => {
    const browser = new Browser();
    await browser.signIn(allowedClaims('gina', 'gina@example.com'));
    const key = ((await fetch(`${hdxUrl}/api/me`, { headers: { cookie: browser.cookies(hdxUrl) } }).then((r) => r.json())) as {
      accessKey: string;
    }).accessKey;
    const v2 = (accessKey: string) => fetch(`${hdxUrl}/api/api/v2/`, { headers: { authorization: `Bearer ${accessKey}` } });
    expect((await v2(key)).status).toBe(200);
    // Removed from the allowed group at the provider:
    const denied = await new Browser().signIn({ ...allowedClaims('gina', 'gina@example.com'), groups: ['former'] });
    expect(denied.response.status).toBe(403);
    expect((await v2(key)).status).toBe(401);
  });

  it('applies a configuration change without a restart: second provider, password login off', async () => {
    const applied = /"message":"OIDC configuration applied".*"second"/;
    const before = countLogMatches(applied);
    writeConfig({ providers: [PROVIDER, { ...PROVIDER, id: 'second', displayName: 'Second IdP' }], passwordLogin: false });
    await waitForLog(applied, before);

    const chooser = await fetch(`${hdxUrl}/api/login/oidc`);
    const html = await chooser.text();
    expect(html).toContain('href="/api/login/oidc/mock"');
    expect(html).toContain('href="/api/login/oidc/second"');
    expect(html).not.toContain('email and password');

    const password = await fetch(`${hdxUrl}/api/login/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=alice@example.com&password=whatever',
    });
    expect(password.status).toBe(303);
    expect(password.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);

    // Express matches routes case-insensitively: the policy must hold for any spelling.
    for (const path of ['/api/Login/Password', '/api/LOGIN/PASSWORD']) {
      const response = await fetch(`${hdxUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }).toString(),
      });
      const cookie = response.headers.getSetCookie().map((header) => header.split(';')[0]).join('; ');
      const me = await fetch(`${hdxUrl}/api/me`, { headers: { cookie } });
      expect([path, me.status]).toEqual([path, 401]);
    }

    // Team-invite acceptance creates a password account too; it is refused.
    const inviter = new Browser();
    await inviter.signIn(allowedClaims('alice', 'alice@example.com'));
    const invitation = await fetch(`${hdxUrl}/api/team/invitation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: inviter.cookies(hdxUrl) },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(invitation.status).toBe(200);
    const url = new URL(((await invitation.json()) as { url: string }).url);
    const token = url.searchParams.get('token') ?? url.pathname.split('/').pop();
    const setup = await fetch(`${hdxUrl}/api/team/setup/${token}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'Invitee-Passw0rd!' }).toString(),
    });
    expect(setup.status).toBe(303);
    expect(setup.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);

    const browser = new Browser();
    await browser.signIn(allowedClaims('dave', 'dave@example.com'), 'second');
    expect((await browser.me()).status).toBe(200);
  });

  it('keeps the last good configuration when a new one is invalid', async () => {
    const rejected = /OIDC configuration rejected; keeping the previous one/;
    const before = countLogMatches(rejected);
    writeFileSync(join(workDir, 'config.json'), '{"providers":[{"id":"BAD"}]}');
    await waitForLog(rejected, before);
    const browser = new Browser();
    await browser.signIn(allowedClaims('erin', 'erin@example.com'));
    expect((await browser.me()).status).toBe(200);
  });

  it('logs an OIDC session out once it exceeds maxSessionAge', async () => {
    const applied = /"message":"OIDC configuration applied".*"maxSessionAgeMs":3000/;
    const before = countLogMatches(applied);
    writeConfig({ providers: [PROVIDER], maxSessionAge: '3s' });
    await waitForLog(applied, before);
    const browser = new Browser();
    await browser.signIn(allowedClaims('frank', 'frank@example.com'));
    expect((await browser.me()).status).toBe(200);
    await Bun.sleep(4500);
    expect((await browser.me()).status).toBe(401);
  });
});
