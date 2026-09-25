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
 *
 * A third HyperDX is reached only through a Caddy reverse proxy, as in
 * production: the browser uses a public name on the default port, so the Host
 * header HyperDX receives carries no port. That is the case HyperDX's UI
 * proxy mishandles for relative redirects from the API (see redirects.ts in
 * the plugin).
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { makeClickstackBootstrap } from '../../../src/factories/clickstack/index.js';
import { HYPERDX_OIDC_PLUGIN_BASE64 } from '../../../src/factories/clickstack/hyperdx-oidc/plugin-bundle.generated.js';

setDefaultTimeout(300_000);

const HYPERDX_IMAGE =
  process.env.HYPERDX_OIDC_TEST_IMAGE ?? 'docker.hyperdx.io/hyperdx/hyperdx:2.35.0';
const MONGO_IMAGE = 'mongo:7.0';
const MOCK_IMAGE = 'ghcr.io/navikt/mock-oauth2-server:2.1.10';
const CADDY_IMAGE = 'caddy:2.11.2';
const MOCK_INTERNAL = 'http://mockoidc:8080';
/**
 * The public origin of the proxied HyperDX: default port, so no port in the
 * Host header. The browser reaches it through Caddy's published port (the
 * Browser rewrites the origin); Caddy forwards `Host: hyperdx.example.test`,
 * exactly what it forwards for a browser on the real name.
 */
const PUBLIC_HOST = 'hyperdx.example.test';
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
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
/** A third HyperDX, on its own database and configuration, reached only through the reverse proxy. */
const HYPERDX_PROXIED = `typekro-oidc-hdx-proxied-${suffix}`;
const PROXY = `typekro-oidc-proxy-${suffix}`;
/**
 * A fourth HyperDX, on its own database, wired as the composition renders it
 * WITHOUT initialUser: the team-bootstrap CronJob creates the Team, so the
 * plugin never does.
 */
const HYPERDX_DEGRADED = `typekro-oidc-hdx-degraded-${suffix}`;
const CONTAINERS = [PROXY, HYPERDX, HYPERDX_OPEN, HYPERDX_PROXIED, HYPERDX_DEGRADED, MOCK, MONGO];

let hdxUrl = '';
let openUrl = '';
let degradedUrl = '';
/** The degraded HyperDX's own configuration directory. */
let degradedConfigDir = '';
let mockExternal = '';
/** Caddy's published address, standing in for PUBLIC_ORIGIN. */
let proxyExternal = '';
let workDir = '';
/** The proxied HyperDX's own configuration directory. */
let proxiedConfigDir = '';
/** Stands in for the projected initialUser password Secret: bind-mounted at the plugin's bootstrap directory. */
let bootstrapDir = '';
/** When the initialUser HyperDX container started; unchanged means it was never restarted. */
let hdxStartedAt = '';

const PROVIDER = {
  id: 'mock',
  displayName: 'Mock IdP',
  issuer: `${MOCK_INTERNAL}/default`,
  clientId: 'hyperdx',
  clientSecret: 'secret',
  allow: { groups: ['hyperdx-users'] },
};

function writeConfig(config: Record<string, unknown>, dir = workDir) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ allowInsecureHttp: true, ...config }), {
    mode: 0o644,
  });
}

/**
 * Set (or remove) the bootstrap password file the way the kubelet updates a
 * Secret volume: the new content appears atomically, never half-written.
 * World-readable, as a Secret volume's default mode is: HyperDX runs as
 * another user inside the container.
 */
function setBootstrapPassword(password: string | undefined) {
  const file = join(bootstrapDir, 'password');
  if (password === undefined) {
    rmSync(file, { force: true });
    return;
  }
  const next = join(bootstrapDir, '.password.next');
  writeFileSync(next, password);
  chmodSync(next, 0o644);
  renameSync(next, file);
}

/** How many HyperDX log lines match (stdout and stderr interleave, so count rather than slice). */
function countLogMatches(pattern: RegExp, container = HYPERDX): number {
  const logs = docker(['logs', container]);
  return `${logs.stdout}\n${logs.stderr}`.split('\n').filter((line) => pattern.test(line)).length;
}

/** Wait until more HyperDX log lines match `pattern` than did before. */
async function waitForLog(pattern: RegExp, matchesBefore = 0, container = HYPERDX): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (countLogMatches(pattern, container) > matchesBefore) return;
    await Bun.sleep(1000);
  }
  throw new Error(`HyperDX (${container}) never logged ${pattern}`);
}

/**
 * A minimal browser: per-host cookie jar, manual redirects, internal→external
 * rewrite for the mock IdP and the proxied HyperDX's public origin. Every
 * redirect target it is sent to is recorded, as the server sent it.
 */
class Browser {
  private readonly jar = new Map<string, Map<string, string>>();
  /** Every `Location` received, in order, before any rewrite. */
  readonly locations: string[] = [];

  private rewrite(url: string): string {
    const parsed = new URL(url);
    // Exact origin match: `http://hyperdx.example.test:8000` is NOT the public origin.
    if (parsed.origin === PUBLIC_ORIGIN)
      return `${proxyExternal}${parsed.pathname}${parsed.search}`;
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
      const name = (pair as string).slice(0, index);
      const value = (pair as string).slice(index + 1);
      // A cookie cleared by the server (`Max-Age=0`) is gone, as in a browser.
      if (/;\s*max-age=0\s*(;|$)/i.test(header)) cookies.delete(name);
      else cookies.set(name, value);
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
        this.locations.push(location);
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
      body: new URLSearchParams({
        username: String(claims.sub ?? 'user'),
        claims: JSON.stringify(claims),
      }).toString(),
    });
  }

  async me(base = hdxUrl): Promise<{ status: number; body?: { id: string; email: string } }> {
    const response = await fetch(`${this.rewrite(base)}/api/me`, {
      headers: { cookie: this.cookies(this.rewrite(base)) },
    });
    return response.status === 200
      ? { status: 200, body: (await response.json()) as { id: string; email: string } }
      : { status: response.status };
  }
}

/** The composition without initialUser, with hyperdxOidc: its HyperDX values and bootstrap CronJob. */
function renderDegraded() {
  const yaml = makeClickstackBootstrap({
    hyperdxOidc: { configSecretRef: { name: 'hyperdx-oidc' } },
  })
    .factory('direct', { namespace: 'clickstack' })
    .toYaml({
      name: 'clickstack',
      namespace: 'clickstack',
      clickhouse: { host: 'clickhouse', username: 'hyperdx', password: 'ch-secret' },
      apiKey: '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
    } as never);
  return (loadAll(yaml) as Record<string, any>[]).filter(Boolean);
}
function degradedDeployment(): Record<string, unknown> {
  const release = renderDegraded().find(
    (doc) => doc.kind === 'HelmRelease' && doc.spec?.chart?.spec?.chart === 'clickstack'
  );
  return release?.spec.values.hyperdx.deployment;
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
  writeFileSync(join(workDir, 'plugin.js'), Buffer.from(HYPERDX_OIDC_PLUGIN_BASE64, 'base64'), {
    mode: 0o644,
  });
  // OIDC-only from the very first start: initialUser must still bootstrap.
  writeConfig({ providers: [PROVIDER], passwordLogin: false });
  // The initialUser password key is NOT in the Secret yet when HyperDX starts:
  // an empty directory, as a Secret volume with an optional, absent key is.
  bootstrapDir = join(workDir, 'bootstrap');
  mkdirSync(bootstrapDir);
  chmodSync(bootstrapDir, 0o755);

  // The proxied HyperDX has its own configuration, so the tests below that
  // rewrite the shared one do not reach it.
  proxiedConfigDir = join(workDir, 'proxied');
  mkdirSync(proxiedConfigDir);
  chmodSync(proxiedConfigDir, 0o755);
  writeConfig({ providers: [PROVIDER], passwordLogin: false }, proxiedConfigDir);
  degradedConfigDir = join(workDir, 'degraded');
  mkdirSync(degradedConfigDir);
  chmodSync(degradedConfigDir, 0o755);
  writeConfig({ providers: [PROVIDER] }, degradedConfigDir);
  const caddyDir = join(workDir, 'caddy');
  mkdirSync(caddyDir);
  chmodSync(caddyDir, 0o755);
  // Plain HTTP on the default port. `header_up Host` sets what a browser on
  // the public name sends (Caddy forwards Host unchanged otherwise); the test
  // itself can only reach Caddy through a published port.
  writeFileSync(
    join(caddyDir, 'Caddyfile'),
    `{\n\tauto_https off\n\tadmin off\n}\n:80 {\n\treverse_proxy ${HYPERDX_PROXIED}:8080 {\n\t\theader_up Host ${PUBLIC_HOST}\n\t}\n}\n`,
    { mode: 0o644 }
  );

  const hdxPort = await freePort();
  const mockPort = await freePort();
  const openPort = await freePort();
  const proxyPort = await freePort();
  const degradedPort = await freePort();
  degradedUrl = `http://localhost:${degradedPort}`;
  hdxUrl = `http://localhost:${hdxPort}`;
  openUrl = `http://localhost:${openPort}`;
  mockExternal = `http://localhost:${mockPort}`;
  proxyExternal = `http://localhost:${proxyPort}`;

  for (const name of CONTAINERS) docker(['rm', '-f', '-v', name]);
  docker(['network', 'rm', NETWORK]);
  expect(docker(['network', 'create', NETWORK]).ok).toBe(true);
  expect(docker(['run', '-d', '--name', MONGO, '--network', NETWORK, MONGO_IMAGE]).ok).toBe(true);
  expect(
    docker([
      'run',
      '-d',
      '--name',
      MOCK,
      '--network',
      NETWORK,
      '--network-alias',
      'mockoidc',
      '-p',
      `${mockPort}:8080`,
      '-e',
      'JSON_CONFIG={"interactiveLogin":true}',
      MOCK_IMAGE,
    ]).ok
  ).toBe(true);
  const started = docker([
    'run',
    '-d',
    '--name',
    HYPERDX,
    '--network',
    NETWORK,
    '-p',
    `${hdxPort}:8080`,
    '-e',
    `MONGO_URI=mongodb://${MONGO}:27017/hyperdx`,
    '-e',
    `FRONTEND_URL=${hdxUrl}`,
    '-e',
    'HYPERDX_APP_PORT=8080',
    // Exactly the wiring TypeKro renders (hyperdx-oidc/index.ts).
    '-e',
    'NODE_OPTIONS=--require=/opt/typekro/hyperdx-oidc/plugin.js',
    '-e',
    'TYPEKRO_HDX_OIDC_CONFIG=/etc/typekro/hyperdx-oidc/config.json',
    '-e',
    'TYPEKRO_HDX_OIDC_RELOAD_SECONDS=1',
    // As with initialUser: the team is claimed by a password registration,
    // never by a first OIDC login.
    '-e',
    'TYPEKRO_HDX_OIDC_CREATE_TEAM=false',
    // ...and only the initialUser's own registration passes passwordLogin: false,
    // its password read from the projected Secret file on every attempt.
    '-e',
    `TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL=${ADMIN.email}`,
    '-e',
    'TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE=/etc/typekro/hyperdx-bootstrap/password',
    '-v',
    `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v',
    `${workDir}:/etc/typekro/hyperdx-oidc:ro`,
    // A whole directory, like the Secret volume (no subPath), so changes show through.
    '-v',
    `${bootstrapDir}:/etc/typekro/hyperdx-bootstrap:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!started.ok) throw new Error(`docker run hyperdx failed: ${started.stderr}`);
  const openStarted = docker([
    'run',
    '-d',
    '--name',
    HYPERDX_OPEN,
    '--network',
    NETWORK,
    '-p',
    `${openPort}:8080`,
    '-e',
    `MONGO_URI=mongodb://${MONGO}:27017/hyperdx-open`,
    '-e',
    `FRONTEND_URL=${openUrl}`,
    '-e',
    'HYPERDX_APP_PORT=8080',
    '-e',
    'NODE_OPTIONS=--require=/opt/typekro/hyperdx-oidc/plugin.js',
    '-e',
    'TYPEKRO_HDX_OIDC_CONFIG=/etc/typekro/hyperdx-oidc/config.json',
    '-e',
    'TYPEKRO_HDX_OIDC_CREATE_TEAM=true',
    '-v',
    `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v',
    `${workDir}:/etc/typekro/hyperdx-oidc:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!openStarted.ok) throw new Error(`docker run hyperdx (open) failed: ${openStarted.stderr}`);
  const proxiedStarted = docker([
    'run',
    '-d',
    '--name',
    HYPERDX_PROXIED,
    '--network',
    NETWORK,
    '-e',
    `MONGO_URI=mongodb://${MONGO}:27017/hyperdx-proxied`,
    // The public URL, as a deployment behind a reverse proxy sets it.
    '-e',
    `FRONTEND_URL=${PUBLIC_ORIGIN}`,
    '-e',
    'HYPERDX_APP_PORT=8080',
    '-e',
    'NODE_OPTIONS=--require=/opt/typekro/hyperdx-oidc/plugin.js',
    '-e',
    'TYPEKRO_HDX_OIDC_CONFIG=/etc/typekro/hyperdx-oidc/config.json',
    '-e',
    'TYPEKRO_HDX_OIDC_RELOAD_SECONDS=1',
    '-e',
    'TYPEKRO_HDX_OIDC_CREATE_TEAM=true',
    // As `hyperdxOidc.passwordLoginPath` renders it: this proxy's bare
    // `/login` would start SSO, so the chooser links the password form here.
    '-e',
    'TYPEKRO_HDX_OIDC_PASSWORD_LOGIN_PATH=/login?password',
    '-v',
    `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v',
    `${proxiedConfigDir}:/etc/typekro/hyperdx-oidc:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!proxiedStarted.ok)
    throw new Error(`docker run hyperdx (proxied) failed: ${proxiedStarted.stderr}`);
  // The plugin env exactly as the composition renders it without initialUser.
  const degradedEnv = (degradedDeployment().env as Array<{ name: string; value: string }>).flatMap(
    ({ name, value }) => ['-e', `${name}=${value}`]
  );
  const degradedStarted = docker([
    'run',
    '-d',
    '--name',
    HYPERDX_DEGRADED,
    '--network',
    NETWORK,
    '-p',
    `${degradedPort}:8080`,
    '-e',
    `MONGO_URI=mongodb://${MONGO}:27017/hyperdx-degraded`,
    '-e',
    `FRONTEND_URL=${degradedUrl}`,
    '-e',
    'HYPERDX_APP_PORT=8080',
    ...degradedEnv,
    '-v',
    `${join(workDir, 'plugin.js')}:/opt/typekro/hyperdx-oidc/plugin.js:ro`,
    '-v',
    `${degradedConfigDir}:/etc/typekro/hyperdx-oidc:ro`,
    HYPERDX_IMAGE,
  ]);
  if (!degradedStarted.ok)
    throw new Error(`docker run hyperdx (degraded) failed: ${degradedStarted.stderr}`);
  const proxyStarted = docker([
    'run',
    '-d',
    '--name',
    PROXY,
    '--network',
    NETWORK,
    '-p',
    `${proxyPort}:80`,
    '-v',
    `${caddyDir}:/etc/caddy:ro`,
    CADDY_IMAGE,
  ]);
  if (!proxyStarted.ok) throw new Error(`docker run caddy failed: ${proxyStarted.stderr}`);

  // The mock provider must be serving discovery before HyperDX's plugin (and
  // the browser) use it.
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${mockExternal}/default/.well-known/openid-configuration`)).status === 200)
        break;
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
  hdxStartedAt = docker(['inspect', '-f', '{{.State.StartedAt}}', HYPERDX]).stdout;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${openUrl}/api/installation`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const logs = docker(['logs', HYPERDX_OPEN]);
    if (
      `${logs.stdout}\n${logs.stderr}`.includes(
        '"message":"OIDC configuration applied","providers":["mock"]'
      )
    )
      break;
    await Bun.sleep(1000);
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${proxyExternal}/api/installation`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  await waitForLog(
    /"message":"OIDC configuration applied","providers":\["mock"\]/,
    0,
    HYPERDX_PROXIED
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${degradedUrl}/api/installation`)).status === 200) break;
    } catch {}
    await Bun.sleep(1000);
  }
  await waitForLog(
    /"message":"OIDC configuration applied","providers":\["mock"\]/,
    0,
    HYPERDX_DEGRADED
  );
});

afterAll(() => {
  if (!dockerAvailable) return;
  // -v: MongoDB's image declares volumes; without it every run leaks them.
  for (const name of CONTAINERS) docker(['rm', '-f', '-v', name]);
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
        const landed = await new Browser().signIn(
          allowedClaims(`racer-${n}`, `racer-${n}@example.com`),
          'mock',
          openUrl
        );
        status = landed.response.status;
        if (status !== 403) break;
      }
      return status;
    };
    const statuses = await Promise.all([1, 2, 3, 4, 5].map(signIn));
    expect(
      statuses.every((status) => status === 200 || status === 503),
      `statuses: ${statuses.join(',')}`
    ).toBe(true);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    const teams = docker([
      'exec',
      MONGO,
      'mongosh',
      '--quiet',
      'mongodb://localhost:27017/hyperdx-open',
      '--eval',
      'db.teams.countDocuments()',
    ]);
    expect(teams.stdout.trim()).toBe('1');
  });

  it('does not create the team on a first OIDC login when initialUser claims the instance', async () => {
    const browser = new Browser();
    const landed = await browser.signIn(allowedClaims('early', 'early@example.com'));
    expect(landed.response.status).toBe(503);
    expect(await landed.response.text()).toContain('still being set up');
    expect((await fetch(`${hdxUrl}/api/installation`).then((r) => r.json())) as object).toEqual({
      isTeamExisting: false,
    });
  });

  const register = (account: { email: string; password: string }) =>
    fetch(`${hdxUrl}/api/register/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...account, confirmPassword: account.password }),
    });
  const hyperdxDb = (query: string) =>
    docker([
      'exec',
      MONGO,
      'mongosh',
      '--quiet',
      'mongodb://localhost:27017/hyperdx',
      '--eval',
      query,
    ]).stdout.trim();

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
    expect((await fetch(`${hdxUrl}/api/installation`).then((r) => r.json())) as object).toEqual({
      isTeamExisting: false,
    });
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('0');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('0');
  });

  /**
   * A registration that the plugin's exemption admits but HyperDX itself
   * rejects without consuming anything: `confirmPassword` differs, so
   * HyperDX's own schema validation answers 400 before its handler runs.
   * 400 means the plugin let it through; 303 means the plugin refused it.
   */
  const probe = (account: { email: string; password: string }) =>
    fetch(`${hdxUrl}/api/register/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...account, confirmPassword: `${account.password}-mismatch` }),
    });
  /** The initialUser password before it was rotated. */
  const OLD_PASSWORD = 'Before-Rotation-Passw0rd!';

  it("refuses even the initialUser's registration while its password file is absent", async () => {
    // HyperDX started before the key was in the Secret: the exemption is armed
    // but refuses, and says so at startup (without any password).
    expect(countLogMatches(/bootstrap password file is absent or empty/)).toBeGreaterThanOrEqual(1);
    const response = await register(ADMIN);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);
    expect((await probe(ADMIN)).status).toBe(303);
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('0');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('0');
  });

  it('picks up the password file when it appears, and follows a rotation, without a restart', async () => {
    // The key is added to the Secret: the next attempt reads it.
    setBootstrapPassword(OLD_PASSWORD);
    expect((await probe({ email: ADMIN.email, password: OLD_PASSWORD })).status).toBe(400);
    expect((await probe(ADMIN)).status).toBe(303);
    // Rotated before the bootstrap registered: the old password is refused
    // and the new one admitted.
    setBootstrapPassword(ADMIN.password);
    const old = await register({ email: ADMIN.email, password: OLD_PASSWORD });
    expect(old.status).toBe(303);
    expect(old.headers.get('location')).toBe(`${hdxUrl}/login?err=passwordAuthNotAllowed`);
    expect((await probe(ADMIN)).status).toBe(400);
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('0');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('0');
  });

  it('lets the initialUser registration claim the instance even with passwordLogin: false', async () => {
    // What TypeKro's initialUser CronJob does, with the configuration
    // OIDC-only from the start and the password key added after HyperDX
    // started.
    expect((await register(ADMIN)).status).toBe(200);
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('1');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('1');
    // Never restarted: every change above reached the running process.
    expect(docker(['inspect', '-f', '{{.State.StartedAt}}', HYPERDX]).stdout).toBe(hdxStartedAt);
    // The plugin reads the passwords; they must never reach the logs.
    expect(countLogMatches(/Break-Glass-Passw0rd|Before-Rotation-Passw0rd/)).toBe(0);

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

  it('refuses every registration identically once a team exists, so none can test a password', async () => {
    // The correct initial password must not be told apart from a wrong one
    // (upstream would answer 409 to the first and the plugin 303 to the
    // second): once a team exists, the plugin compares nothing.
    const answers: [number, string | null][] = [];
    for (const account of [
      ADMIN,
      { email: ADMIN.email, password: 'Wrong-Passw0rd!1' },
      { email: 'other@example.com', password: ADMIN.password },
    ]) {
      const response = await register(account);
      answers.push([response.status, response.headers.get('location')]);
    }
    const refusal: [number, string] = [303, `${hdxUrl}/login?err=passwordAuthNotAllowed`];
    expect(answers).toEqual([refusal, refusal, refusal]);
    // Nor does a correct-credentials request reach HyperDX's own validation.
    expect((await probe(ADMIN)).status).toBe(303);
    expect(hyperdxDb('db.teams.countDocuments()')).toBe('1');
    expect(hyperdxDb('db.users.countDocuments()')).toBe('1');
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

  it('completes two sign-ins started in one browser before either returns, in either order', async () => {
    // A reverse proxy that starts sign-in for every signed-out page load (a
    // browser restoring several tabs, links opened from chat) starts several
    // flows in one session. Each must complete on its own returnTo: the
    // second start must not overwrite the first, and the first callback
    // (which regenerates the session on login) must not drop the second.
    const submit = (browser: Browser, formUrl: string) =>
      browser.go(formUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: 'tabs',
          claims: JSON.stringify(allowedClaims('tabs', 'tabs@example.com')),
        }).toString(),
      });
    for (const order of [
      ['first', 'second'],
      ['second', 'first'],
    ] as const) {
      const browser = new Browser();
      const forms = {
        first: await browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2F`),
        second: await browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2Fsearch`),
      };
      expect(forms.first.response.status, `login form at ${forms.first.url}`).toBe(200);
      expect(forms.second.response.status, `login form at ${forms.second.url}`).toBe(200);
      const expected = { first: `${hdxUrl}/`, second: `${hdxUrl}/search` };
      for (const tab of order) {
        const landed = await submit(browser, forms[tab].url);
        expect([order, tab, landed.response.status, landed.url]).toEqual([
          order,
          tab,
          200,
          expected[tab],
        ]);
        expect((await browser.me()).body?.email).toBe('tabs@example.com');
      }
    }
  });

  /** Submit the mock provider's form for a login flow; returns where the browser lands. */
  const completeFlow = (browser: Browser, formUrl: string, sub: string) =>
    browser.go(formUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: sub,
        claims: JSON.stringify(allowedClaims(sub, `${sub}@example.com`)),
      }).toString(),
    });
  /** Start two sign-ins in one browser at the same moment, as restored tabs do. */
  const startTogether = async (browser: Browser) => {
    const [first, second] = await Promise.all([
      browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2F`),
      browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2Fsearch`),
    ]);
    expect(
      [first.response.status, second.response.status],
      `login forms at ${first.url} and ${second.url}`
    ).toEqual([200, 200]);
    return { first, second };
  };
  const RACE_RUNS = 5;

  it('completes sign-ins started at the same moment in a browser with no HyperDX session yet', async () => {
    // Each start used to create its own session; the browser kept only the
    // last session cookie, so the other sign-in's pending state was lost.
    for (let run = 0; run < RACE_RUNS; run++) {
      const browser = new Browser();
      const { first, second } = await startTogether(browser);
      const landedFirst = await completeFlow(browser, first.url, 'racetabs');
      const landedSecond = await completeFlow(browser, second.url, 'racetabs');
      expect([run, landedFirst.response.status, landedFirst.url]).toEqual([run, 200, `${hdxUrl}/`]);
      expect([run, landedSecond.response.status, landedSecond.url]).toEqual([
        run,
        200,
        `${hdxUrl}/search`,
      ]);
      expect((await browser.me()).body?.email).toBe('racetabs@example.com');
    }
  });

  it('completes sign-ins started at the same moment in a browser that already has a HyperDX session', async () => {
    // Two starts loading and saving one session: the last save used to win,
    // dropping the other sign-in's pending state.
    for (let run = 0; run < RACE_RUNS; run++) {
      const browser = new Browser();
      await browser.signIn(allowedClaims('racetabs', 'racetabs@example.com'));
      expect((await browser.me()).status).toBe(200);
      const { first, second } = await startTogether(browser);
      const landedFirst = await completeFlow(browser, first.url, 'racetabs');
      const landedSecond = await completeFlow(browser, second.url, 'racetabs');
      expect([run, landedFirst.response.status, landedFirst.url]).toEqual([run, 200, `${hdxUrl}/`]);
      expect([run, landedSecond.response.status, landedSecond.url]).toEqual([
        run,
        200,
        `${hdxUrl}/search`,
      ]);
    }
  });

  it('completes callbacks that return at the same moment, and refuses each replayed before any token exchange', async () => {
    const noPending = /"message":"OIDC callback matched no pending sign-in"/;
    // Every path past the pending-login lookup (token exchange, then a
    // denial or a login) logs one of these.
    const pastLookup = /"message":"OIDC login( failed| denied)?"/;
    for (let run = 0; run < RACE_RUNS; run++) {
      const browser = new Browser();
      // Started one after the other, so this isolates the callbacks racing.
      const first = await browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2F`);
      const second = await browser.go(`${hdxUrl}/api/login/oidc/mock?returnTo=%2Fsearch`);
      const [landedFirst, landedSecond] = await Promise.all([
        completeFlow(browser, first.url, 'racetabs'),
        completeFlow(browser, second.url, 'racetabs'),
      ]);
      expect([run, landedFirst.response.status, landedFirst.url]).toEqual([run, 200, `${hdxUrl}/`]);
      expect([run, landedSecond.response.status, landedSecond.url]).toEqual([
        run,
        200,
        `${hdxUrl}/search`,
      ]);
      expect((await browser.me()).body?.email).toBe('racetabs@example.com');

      // Each callback URL, used once, is refused at the pending-login lookup:
      // a used one never reaches the provider's token endpoint again.
      const callbacks = browser.locations.filter((location) =>
        location.includes('/api/login/oidc/mock/callback?')
      );
      expect(callbacks).toHaveLength(2);
      const replays: Array<{
        refused: number;
        pastLookup: number;
        status: number;
        expired: boolean;
      }> = [];
      for (const callback of callbacks) {
        const before = {
          refused: countLogMatches(noPending),
          pastLookup: countLogMatches(pastLookup),
        };
        const replayed = await browser.go(callback);
        const counts = () => ({
          refused: countLogMatches(noPending) - before.refused,
          pastLookup: countLogMatches(pastLookup) - before.pastLookup,
        });
        // Wait for the plugin to log the outcome, whichever it is.
        for (
          let attempt = 0;
          attempt < 15 && counts().refused + counts().pastLookup === 0;
          attempt++
        )
          await Bun.sleep(1000);
        const text = await replayed.response.text();
        replays.push({
          ...counts(),
          status: replayed.response.status,
          expired: text.includes('The sign-in took too long'),
        });
      }
      const refusedAtLookup = { refused: 1, pastLookup: 0, status: 403, expired: true };
      expect({ run, replays }).toEqual({ run, replays: [refusedAtLookup, refusedAtLookup] });
    }
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
    const landed = await browser.signIn({
      ...allowedClaims('bob', 'bob@example.com'),
      groups: ['other'],
    });
    expect(landed.response.status).toBe(403);
    expect(await landed.response.text()).toContain('not in a group');
    expect((await browser.me()).status).toBe(401);
  });

  it('refuses an unverified email', async () => {
    const browser = new Browser();
    const landed = await browser.signIn({
      ...allowedClaims('carol', 'carol@example.com'),
      email_verified: false,
    });
    expect(landed.response.status).toBe(403);
    expect((await browser.me()).status).toBe(401);
  });

  it('gives an email to exactly one subject when several race to claim it', async () => {
    // The unique userId index, not the read-then-write, is what guarantees this.
    const racer = async (n: number) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const landed = await new Browser().signIn(
          allowedClaims(`shared-${n}`, 'shared@example.com')
        );
        const body = await landed.response.text();
        // Retry only the mock provider's occasional dropped nonce.
        if (landed.response.status !== 403 || body.includes('already belongs to another sign-in')) {
          return landed.response.status;
        }
      }
      return 0;
    };
    const statuses = await Promise.all([1, 2, 3, 4].map(racer));
    expect(
      statuses.filter((status) => status === 200),
      `statuses: ${statuses.join(',')}`
    ).toHaveLength(1);
    expect(statuses.filter((status) => status === 403)).toHaveLength(3);
    const mongo = (query: string) =>
      docker([
        'exec',
        MONGO,
        'mongosh',
        '--quiet',
        'mongodb://localhost:27017/hyperdx',
        '--eval',
        query,
      ]).stdout.trim();
    expect(mongo("db.users.countDocuments({ email: 'shared@example.com' })")).toBe('1');
    expect(
      mongo("db.typekro_oidc_identities.countDocuments({ email: 'shared@example.com' })")
    ).toBe('1');
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
    const key = (
      (await fetch(`${hdxUrl}/api/me`, { headers: { cookie: browser.cookies(hdxUrl) } }).then((r) =>
        r.json()
      )) as {
        accessKey: string;
      }
    ).accessKey;
    const v2 = (accessKey: string) =>
      fetch(`${hdxUrl}/api/api/v2/`, { headers: { authorization: `Bearer ${accessKey}` } });
    expect((await v2(key)).status).toBe(200);
    // Removed from the allowed group at the provider:
    const denied = await new Browser().signIn({
      ...allowedClaims('gina', 'gina@example.com'),
      groups: ['former'],
    });
    expect(denied.response.status).toBe(403);
    expect((await v2(key)).status).toBe(401);
  });

  it('applies a configuration change without a restart: second provider, password login off', async () => {
    const applied = /"message":"OIDC configuration applied".*"second"/;
    const before = countLogMatches(applied);
    writeConfig({
      providers: [PROVIDER, { ...PROVIDER, id: 'second', displayName: 'Second IdP' }],
      passwordLogin: false,
    });
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
      const cookie = response.headers
        .getSetCookie()
        .map((header) => header.split(';')[0])
        .join('; ');
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

describeOrSkip('HyperDX OIDC plugin behind a reverse proxy (no port in the Host header)', () => {
  /** What HyperDX's UI proxy makes of a relative redirect when the Host header has no port. */
  const apiPortLeak = /:8000\b/;

  it("redirects the provider chooser to the public URL, not the API server's port", async () => {
    for (const [query, expected] of [
      ['', `${PUBLIC_ORIGIN}/api/login/oidc/mock`],
      ['?returnTo=%2Fsearch', `${PUBLIC_ORIGIN}/api/login/oidc/mock?returnTo=%2Fsearch`],
    ] as const) {
      const response = await fetch(`${proxyExternal}/api/login/oidc${query}`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(expected);
    }
    // FRONTEND_URL is a valid public URL: no fallback to relative redirects.
    expect(countLogMatches(/FRONTEND_URL (is not set|is not a valid)/, HYPERDX_PROXIED)).toBe(0);
  });

  it('signs in from the chooser: provider route, issuer, callback, then the public UI', async () => {
    const browser = new Browser();
    const form = await browser.go(`${PUBLIC_ORIGIN}/api/login/oidc?returnTo=%2Fsearch`);
    expect(form.response.status, `login form at ${form.url}`).toBe(200);
    expect(browser.locations[0]).toBe(`${PUBLIC_ORIGIN}/api/login/oidc/mock?returnTo=%2Fsearch`);
    expect(
      browser.locations[1]?.startsWith(`${MOCK_INTERNAL}/default/authorize?`),
      browser.locations[1]
    ).toBe(true);
    const authorize = new URL(browser.locations[1] as string);
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_ORIGIN}/api/login/oidc/mock/callback`
    );

    const landed = await browser.go(form.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'proxied',
        claims: JSON.stringify(allowedClaims('proxied', 'proxied@example.com')),
      }).toString(),
    });
    const [callback, postLogin] = browser.locations.slice(2);
    expect(callback?.startsWith(`${PUBLIC_ORIGIN}/api/login/oidc/mock/callback?`), callback).toBe(
      true
    );
    expect(postLogin).toBe(`${PUBLIC_ORIGIN}/search`);
    expect(landed.response.status).toBe(200);
    expect(landed.url).toBe(`${proxyExternal}/search`);
    expect(browser.locations.filter((location) => apiPortLeak.test(location))).toEqual([]);
    expect((await browser.me(PUBLIC_ORIGIN)).body?.email).toBe('proxied@example.com');
  });

  it('sends password-policy refusals to the public login page', async () => {
    const response = await fetch(`${proxyExternal}/api/login/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'proxied@example.com', password: 'whatever' }).toString(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${PUBLIC_ORIGIN}/login?err=passwordAuthNotAllowed`
    );
  });

  it("serves the multi-provider chooser whose links resolve against the page's public URL", async () => {
    const applied = /"message":"OIDC configuration applied".*"second"/;
    const before = countLogMatches(applied, HYPERDX_PROXIED);
    writeConfig(
      {
        providers: [PROVIDER, { ...PROVIDER, id: 'second', displayName: 'Second IdP' }],
        passwordLogin: false,
      },
      proxiedConfigDir
    );
    await waitForLog(applied, before, HYPERDX_PROXIED);

    const browser = new Browser();
    const chooserUrl = `${PUBLIC_ORIGIN}/api/login/oidc`;
    const chooser = await browser.go(chooserUrl);
    expect(chooser.response.status).toBe(200);
    const href = /href="([^"]*\/second)"/.exec(await chooser.response.text())?.[1];
    expect(href).toBeDefined();
    const form = await browser.go(new URL(href as string, chooserUrl).href);
    expect(form.response.status, `login form at ${form.url}`).toBe(200);
    expect(
      browser.locations[0]?.startsWith(`${MOCK_INTERNAL}/default/authorize?`),
      browser.locations[0]
    ).toBe(true);
  });

  it("links the chooser's password form at the configured path, on the public URL", async () => {
    const chooserLink = async () => {
      const html = await (await fetch(`${proxyExternal}/api/login/oidc`)).text();
      return /<a href="([^"]*)">Sign in with email and password<\/a>/.exec(html)?.[1];
    };
    const providers = [PROVIDER, { ...PROVIDER, id: 'second', displayName: 'Second IdP' }];
    // The deployment's path (the env var above), with password login on.
    let applied =
      /"message":"OIDC configuration applied".*"passwordLogin":true,"passwordLoginPath":"\/login\?password"/;
    let before = countLogMatches(applied, HYPERDX_PROXIED);
    writeConfig({ providers, passwordLogin: true }, proxiedConfigDir);
    await waitForLog(applied, before, HYPERDX_PROXIED);
    expect(await chooserLink()).toBe(`${PUBLIC_ORIGIN}/login?password`);
    // The configuration document's own path takes precedence.
    applied = /"message":"OIDC configuration applied".*"passwordLoginPath":"\/login\?via=config"/;
    before = countLogMatches(applied, HYPERDX_PROXIED);
    writeConfig(
      { providers, passwordLogin: true, passwordLoginPath: '/login?via=config' },
      proxiedConfigDir
    );
    await waitForLog(applied, before, HYPERDX_PROXIED);
    expect(await chooserLink()).toBe(`${PUBLIC_ORIGIN}/login?via=config`);
  });
});

describeOrSkip('HyperDX OIDC without initialUser: the bootstrap owns the Team', () => {
  it('answers "still being set up" until the bootstrap creates the one Team, then signs users into it', async () => {
    // Before the CronJob's first run: the plugin does not create a Team, so
    // there can never be a second one next to the CronJob's.
    const early = await new Browser().signIn(
      allowedClaims('early-bird', 'early-bird@example.com'),
      'mock',
      degradedUrl
    );
    expect(early.response.status).toBe(503);
    expect(await early.response.text()).toContain(
      'HyperDX is still being set up. Try again in a minute.'
    );
    const count = (query: string) =>
      docker([
        'exec',
        MONGO,
        'mongosh',
        '--quiet',
        'mongodb://localhost:27017/hyperdx-degraded',
        '--eval',
        query,
      ]).stdout.trim();
    expect(count('db.teams.countDocuments()')).toBe('0');

    // The team-bootstrap CronJob as rendered, its Secret references resolved.
    const cronJob = renderDegraded().find(
      (doc) => doc.kind === 'CronJob' && doc.metadata.name.endsWith('-team-bootstrap')
    );
    const container = cronJob?.spec.jobTemplate.spec.template.spec.containers[0];
    const secret: Record<string, string> = {
      HYPERDX_API_KEY: '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
      CLICKHOUSE_APP_PASSWORD: 'ch-secret',
    };
    const env = (
      container.env as Array<{
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { key: string } };
      }>
    ).flatMap((variable) => [
      '-e',
      `${variable.name}=${variable.value ?? secret[variable.valueFrom?.secretKeyRef.key ?? '']}`,
    ]);
    const bootstrap = docker([
      'run',
      '--rm',
      '--network',
      NETWORK,
      ...env,
      MONGO_IMAGE,
      'mongosh',
      '--quiet',
      `mongodb://${MONGO}:27017/hyperdx`,
      '--eval',
      container.command[4].replace("getSiblingDB('hyperdx')", "getSiblingDB('hyperdx-degraded')"),
    ]);
    expect(bootstrap.ok, bootstrap.stderr).toBe(true);

    // Now OIDC users join that one Team, which has a connection and sources.
    for (const who of ['early-bird', 'second']) {
      const browser = new Browser();
      const landed = await browser.signIn(
        allowedClaims(who, `${who}@example.com`),
        'mock',
        degradedUrl
      );
      expect(landed.response.status).toBe(200);
      expect((await browser.me(degradedUrl)).status).toBe(200);
      const connections = (await fetch(`${degradedUrl}/api/connections`, {
        headers: { cookie: browser.cookies(degradedUrl) },
      }).then((response) => response.json())) as unknown[];
      expect(connections).toHaveLength(1);
    }
    expect(count('db.teams.countDocuments()')).toBe('1');
    expect(count('db.teams.findOne().name')).toBe('ClickStack');
    expect(count('db.users.countDocuments({ team: db.teams.findOne()._id })')).toBe('2');
  });
});
