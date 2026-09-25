/**
 * HyperDX Team defaults and Team name, against the REAL HyperDX image.
 *
 * A Team the bootstrap CronJob inserts itself (no `initialUser`) never passes
 * through HyperDX's `setupTeamDefaults`, so it used to have no ClickHouse
 * connection and no sources, and every signed-in user got HyperDX's "set up
 * your connection" onboarding modal. The CronJob now seeds them. This suite
 * runs the bootstrap scripts EXACTLY as the composition renders them (script,
 * environment and Secret references taken from the direct-mode CronJob) with
 * `mongosh` from the CronJob's image, against MongoDB, ClickHouse and the
 * published `hyperdx` image, and checks what HyperDX and its UI then see.
 *
 * Docker-gated: the suite SKIPS when no Docker daemon is reachable. Set
 * REQUIRE_DOCKER_TESTS=true to make a missing daemon a failure (CI does).
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createServer } from 'node:net';
import { loadAll } from 'js-yaml';
import {
  type ClickStackBuildOptions,
  makeClickstackBootstrap,
} from '../../../src/factories/clickstack/index.js';

setDefaultTimeout(300_000);

const HYPERDX_IMAGE =
  process.env.HYPERDX_OIDC_TEST_IMAGE ?? 'docker.hyperdx.io/hyperdx/hyperdx:2.35.0';
const MONGO_IMAGE = 'mongo:7.0';
const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:25.7';

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
const NETWORK = `typekro-team-defaults-${suffix}`;
const CLICKHOUSE = `typekro-td-ch-${suffix}`;
/** The degraded path (no initialUser): an existing Team from before this fix, and a HyperDX serving it. */
const MONGO_LEGACY = `typekro-td-mongo-legacy-${suffix}`;
const HYPERDX_LEGACY = `typekro-td-hdx-legacy-${suffix}`;
/** The initialUser path: HyperDX's own registration runs setupTeamDefaults, the reference for the shapes. */
const MONGO_REGISTERED = `typekro-td-mongo-registered-${suffix}`;
const HYPERDX_REGISTERED = `typekro-td-hdx-registered-${suffix}`;
/** The degraded path on a fresh instance: the bootstrap creates the Team. No HyperDX needed. */
const MONGO_FRESH = `typekro-td-mongo-fresh-${suffix}`;
const CONTAINERS = [
  HYPERDX_LEGACY,
  HYPERDX_REGISTERED,
  MONGO_LEGACY,
  MONGO_REGISTERED,
  MONGO_FRESH,
  CLICKHOUSE,
];

const API_KEY = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const CLICKHOUSE_USER = 'hyperdx';
const CLICKHOUSE_PASSWORD = 'ch-app-secret-7Q';
const ADMIN = { email: 'ops@example.com', password: 'Bootstrap1!secret' };
const LEGACY_USER = { email: 'legacy@example.com', password: 'Legacy1!secret' };
/** A Team name from before `teamName` existed, as a deployment might still carry it. */
const LEGACY_TEAM_NAME = 'Observability (old default)';

/** What the chart-owned `clickstack-secret` holds, for the CronJob's `secretKeyRef`s. */
const CHART_SECRET: Record<string, string> = {
  HYPERDX_API_KEY: API_KEY,
  CLICKHOUSE_PASSWORD: CLICKHOUSE_PASSWORD,
  CLICKHOUSE_APP_PASSWORD: CLICKHOUSE_PASSWORD,
  HYPERDX_INITIAL_USER_PASSWORD: ADMIN.password,
};

const SPEC = {
  name: 'clickstack',
  namespace: 'clickstack',
  clickhouse: { host: CLICKHOUSE, username: CLICKHOUSE_USER, password: CLICKHOUSE_PASSWORD },
  apiKey: API_KEY,
};

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
}
interface RenderedBootstrap {
  script: string;
  env: EnvVar[];
  /** `DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` exactly as the HelmRelease hands them to HyperDX. */
  defaultConnections: string;
  defaultSources: string;
}

/** The CronJob and HelmRelease values a direct-mode render of the composition produces. */
function render(options: ClickStackBuildOptions): RenderedBootstrap {
  const yaml = makeClickstackBootstrap(options as never)
    .factory('direct', { namespace: 'clickstack' })
    .toYaml(SPEC as never);
  const docs = loadAll(yaml) as Record<string, any>[];
  const cronJob = docs.find(
    (doc) => doc?.kind === 'CronJob' && doc.metadata.name.endsWith('-team-bootstrap')
  );
  const release = docs.find(
    (doc) => doc?.kind === 'HelmRelease' && doc.spec?.chart?.spec?.chart === 'clickstack'
  );
  const container = cronJob?.spec.jobTemplate.spec.template.spec.containers[0];
  return {
    script: container.command[4],
    env: container.env,
    defaultConnections: release?.spec.values.hyperdx.deployment.defaultConnections,
    defaultSources: release?.spec.values.hyperdx.deployment.defaultSources,
  };
}

/**
 * Run a rendered bootstrap the way its CronJob does: `mongosh` from the
 * CronJob's image, the rendered environment, Secret references resolved from
 * {@link CHART_SECRET}. Only the Mongo address differs (a Service DNS name in
 * the cluster, a container name here).
 */
function runBootstrap(
  rendered: RenderedBootstrap,
  mongo: string,
  overrides: Record<string, string> = {}
) {
  const env: string[] = [];
  for (const variable of rendered.env) {
    const value =
      overrides[variable.name] ??
      (variable.valueFrom === undefined
        ? variable.value
        : CHART_SECRET[variable.valueFrom.secretKeyRef.key]);
    if (value !== undefined) env.push('-e', `${variable.name}=${value}`);
  }
  return docker([
    'run',
    '--rm',
    '--network',
    NETWORK,
    ...env,
    MONGO_IMAGE,
    'mongosh',
    '--quiet',
    `mongodb://${mongo}:27017/hyperdx`,
    '--eval',
    rendered.script,
  ]);
}

function mongoEval(mongo: string, script: string): string {
  const result = docker([
    'exec',
    mongo,
    'mongosh',
    '--quiet',
    'mongodb://localhost:27017/hyperdx',
    '--eval',
    script,
  ]);
  if (!result.ok) throw new Error(`mongosh failed: ${result.stderr}`);
  return result.stdout;
}

/** Collections as Extended JSON, so ObjectIds and Dates compare by type as well as value. */
type Doc = Record<string, any>;
interface State {
  teams: Doc[];
  users: Doc[];
  connections: Doc[];
  sources: Doc[];
  typekro_bootstrap: Doc[];
}

function dump(mongo: string): State {
  const collections = ['teams', 'users', 'connections', 'sources', 'typekro_bootstrap'];
  const out = mongoEval(
    mongo,
    `const out = {}; for (const name of ${JSON.stringify(collections)}) out[name] = db.getCollection(name).find().sort({ _id: 1 }).toArray(); print(EJSON.stringify(out, { relaxed: false }));`
  );
  return JSON.parse(out) as State;
}

/** Create a user in a Team with HyperDX's own model, so it can sign in with a password. */
function createUser(
  hyperdx: string,
  mongo: string,
  user: { email: string; password: string },
  hookId: string
) {
  const program = `
const models = require('./models');
const User = require('./models/user').default;
const mongoose = require('mongoose');
(async () => {
  await models.connectDB();
  const team = await mongoose.connection.db.collection('teams').findOne({ hookId: ${JSON.stringify(hookId)} });
  await User.register(new User({ email: ${JSON.stringify(user.email)}, name: ${JSON.stringify(user.email)}, team: team._id }), ${JSON.stringify(user.password)});
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });`;
  const result = docker([
    'exec',
    '-w',
    '/app/packages/api/build',
    '-e',
    `MONGO_URI=mongodb://${mongo}:27017/hyperdx`,
    hyperdx,
    'node',
    '-e',
    program,
  ]);
  if (!result.ok) throw new Error(`creating the user failed: ${result.stderr}`);
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`${url} never answered`);
}

async function signIn(base: string, user: { email: string; password: string }): Promise<string> {
  const response = await fetch(`${base}/api/login/password`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(user).toString(),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
  return cookie;
}

async function api<T>(
  base: string,
  cookie: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(init.headers as Record<string, string>),
    },
  });
  if (!response.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${await response.text()}`
    );
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

/**
 * A document with everything that differs between two instances replaced by
 * its type: ids, timestamps and the Team/connection/source references. What
 * is left is the shape and every configured value.
 */
function normalize(
  document: Record<string, any>,
  sourceNames: Map<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === '_id' || key === 'team' || key === 'connection') out[key] = Object.keys(value)[0];
    else if (key === 'createdAt' || key === 'updatedAt') out[key] = Object.keys(value)[0];
    else if (/SourceId$/.test(key)) out[key] = `ref:${sourceNames.get(value)}`;
    else out[key] = value;
  }
  return out;
}

function seededShapes(state: State) {
  const names = new Map(
    state.sources.map((source) => [source._id.$oid as string, source.name as string])
  );
  return {
    connections: state.connections.map((connection) => normalize(connection, names)),
    sources: Object.fromEntries(
      state.sources.map((source) => [source.name, normalize(source, names)])
    ),
  };
}

/** The initialUser script POSTs /register/password to the HyperDX API Service; here, the container. */
const REGISTERED_API = { HYPERDX_API_BASE_URL: `http://${HYPERDX_REGISTERED}:8000` };

let legacyUrl = '';
let registeredUrl = '';
const degraded = render({});
const withInitialUser = render({ initialUser: { email: ADMIN.email } });

beforeAll(async () => {
  if (!dockerAvailable) return;
  const legacyPort = await freePort();
  const registeredPort = await freePort();
  legacyUrl = `http://localhost:${legacyPort}`;
  registeredUrl = `http://localhost:${registeredPort}`;

  for (const name of CONTAINERS) docker(['rm', '-f', '-v', name]);
  docker(['network', 'rm', NETWORK]);
  expect(docker(['network', 'create', NETWORK]).ok).toBe(true);
  for (const mongo of [MONGO_LEGACY, MONGO_REGISTERED, MONGO_FRESH]) {
    expect(docker(['run', '-d', '--name', mongo, '--network', NETWORK, MONGO_IMAGE]).ok).toBe(true);
  }
  expect(
    docker([
      'run',
      '-d',
      '--name',
      CLICKHOUSE,
      '--network',
      NETWORK,
      '-e',
      `CLICKHOUSE_USER=${CLICKHOUSE_USER}`,
      '-e',
      `CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}`,
      '-e',
      'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
      CLICKHOUSE_IMAGE,
    ]).ok
  ).toBe(true);
  // Both HyperDX instances get DEFAULT_CONNECTIONS / DEFAULT_SOURCES exactly as
  // the chart renders them from TypeKro's values.
  for (const [name, mongo, port, url] of [
    [HYPERDX_LEGACY, MONGO_LEGACY, legacyPort, legacyUrl],
    [HYPERDX_REGISTERED, MONGO_REGISTERED, registeredPort, registeredUrl],
  ] as const) {
    const started = docker([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      NETWORK,
      '-p',
      `${port}:8080`,
      '-e',
      `MONGO_URI=mongodb://${mongo}:27017/hyperdx`,
      '-e',
      `FRONTEND_URL=${url}`,
      '-e',
      'HYPERDX_APP_PORT=8080',
      '-e',
      `DEFAULT_CONNECTIONS=${degraded.defaultConnections}`,
      '-e',
      `DEFAULT_SOURCES=${degraded.defaultSources}`,
      HYPERDX_IMAGE,
    ]);
    if (!started.ok) throw new Error(`docker run hyperdx failed: ${started.stderr}`);
  }
  await waitFor(`${legacyUrl}/api/installation`);
  await waitFor(`${registeredUrl}/api/installation`);

  // A log line to search for, in the table the Logs source points at.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      docker([
        'exec',
        CLICKHOUSE,
        'clickhouse-client',
        '--user',
        CLICKHOUSE_USER,
        '--password',
        CLICKHOUSE_PASSWORD,
        '-q',
        'SELECT 1',
      ]).ok
    )
      break;
    await Bun.sleep(1000);
  }
  for (const query of [
    'CREATE TABLE IF NOT EXISTS default.otel_logs (Timestamp DateTime64(9), ServiceName String, SeverityText String, Body String, TraceId String, SpanId String, LogAttributes Map(String, String), ResourceAttributes Map(String, String)) ENGINE = MergeTree ORDER BY Timestamp',
    "INSERT INTO default.otel_logs (Timestamp, ServiceName, SeverityText, Body) VALUES (now64(9), 'checkout', 'INFO', 'order 42 placed')",
  ]) {
    const result = docker([
      'exec',
      CLICKHOUSE,
      'clickhouse-client',
      '--user',
      CLICKHOUSE_USER,
      '--password',
      CLICKHOUSE_PASSWORD,
      '-q',
      query,
    ]);
    if (!result.ok) throw new Error(`clickhouse: ${result.stderr}`);
  }
});

afterAll(() => {
  if (!dockerAvailable) return;
  // -v: MongoDB's and ClickHouse's images declare volumes; without it every run leaks them.
  for (const name of CONTAINERS) docker(['rm', '-f', '-v', name]);
  docker(['network', 'rm', NETWORK]);
});

describeOrSkip('HyperDX Team defaults on the real HyperDX image', () => {
  it('renders the password as a Secret reference only, never as a value', () => {
    for (const rendered of [degraded, withInitialUser]) {
      expect(rendered.env).toContainEqual({
        name: 'HYPERDX_DEFAULT_CONNECTION_PASSWORD',
        valueFrom: {
          secretKeyRef: {
            name: 'clickstack-secret',
            key: 'CLICKHOUSE_APP_PASSWORD',
            optional: true,
          },
        },
      });
      expect(JSON.stringify(rendered.env)).not.toContain(CLICKHOUSE_PASSWORD);
      expect(rendered.script).not.toContain(CLICKHOUSE_PASSWORD);
    }
  });

  it('creates, names and seeds the Team on a fresh instance, and a second run changes nothing', () => {
    const first = runBootstrap(degraded, MONGO_FRESH);
    expect(first.ok).toBe(true);
    expect(first.stdout).toContain('seeded the "External ClickHouse" connection and 4 sources');
    // The password never reaches the log.
    expect(`${first.stdout}${first.stderr}`).not.toContain(CLICKHOUSE_PASSWORD);

    const state = dump(MONGO_FRESH);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]?.name).toBe('ClickStack');
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.team).toEqual(state.teams[0]?._id);
    expect(state.connections[0]?.password).toBe(CLICKHOUSE_PASSWORD);
    expect(state.sources.map((source) => source.name).sort()).toEqual([
      'Logs',
      'Metrics',
      'Sessions',
      'Traces',
    ]);

    const second = runBootstrap(degraded, MONGO_FRESH);
    expect(second.ok).toBe(true);
    expect(dump(MONGO_FRESH)).toEqual(state);
  });

  it('renames and seeds a Team from before the fix, keeping its _id, apiKey and users', () => {
    // What the bootstrap used to leave behind: its own Team, no connection, no
    // source, no TypeKro markers, and a user who can sign in to it.
    mongoEval(
      MONGO_LEGACY,
      `db.teams.insertOne({ name: ${JSON.stringify(LEGACY_TEAM_NAME)}, allowedAuthMethods: [], hookId: 'typekro-managed-ingestion', apiKey: ${JSON.stringify(API_KEY)}, collectorAuthenticationEnforced: true, isMetricsSeriesTableEnabled: false, createdAt: new Date(Date.now() - 86400000), updatedAt: new Date() });`
    );
    createUser(HYPERDX_LEGACY, MONGO_LEGACY, LEGACY_USER, 'typekro-managed-ingestion');
    const before = dump(MONGO_LEGACY);
    expect(before.connections).toHaveLength(0);
    expect(before.sources).toHaveLength(0);

    const run = runBootstrap(degraded, MONGO_LEGACY);
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain(`renamed the Team from "${LEGACY_TEAM_NAME}" to "ClickStack"`);

    const after = dump(MONGO_LEGACY);
    expect(after.teams).toHaveLength(1);
    expect(after.teams[0]?._id).toEqual(before.teams[0]?._id);
    expect(after.teams[0]?.apiKey).toBe(API_KEY);
    expect(after.teams[0]?.name).toBe('ClickStack');
    expect(after.users).toEqual(before.users);
    expect(after.connections).toHaveLength(1);
    expect(after.sources).toHaveLength(4);
  });

  it("writes exactly what HyperDX's own setupTeamDefaults writes", async () => {
    // The initialUser path registers through HyperDX, which seeds the Team itself.
    const registered = runBootstrap(withInitialUser, MONGO_REGISTERED, REGISTERED_API);
    expect(registered.ok).toBe(true);
    const reference = dump(MONGO_REGISTERED);
    expect(reference.connections).toHaveLength(1);
    expect(reference.sources).toHaveLength(4);

    // Field for field, value for value and BSON type for BSON type.
    const expected = seededShapes(reference);
    expect(Object.keys(expected.sources).sort()).toEqual(['Logs', 'Metrics', 'Sessions', 'Traces']);
    expect(expected.connections[0]).not.toHaveProperty('port');
    expect(expected.sources.Sessions).not.toHaveProperty('bodyExpression');
    expect(seededShapes(dump(MONGO_LEGACY))).toEqual(expected);
  });

  it('never adds to a Team HyperDX seeded at registration', () => {
    // Right after registration the Team is inside the grace period: no decision yet.
    const early = dump(MONGO_REGISTERED);
    expect(early.typekro_bootstrap.map((marker) => marker._id)).toEqual(['initial-user']);

    // Past it, the run records that the Team is configured and writes nothing else.
    mongoEval(
      MONGO_REGISTERED,
      'db.teams.updateMany({}, { $set: { createdAt: new Date(Date.now() - 600000) } });'
    );
    const aged = dump(MONGO_REGISTERED);
    expect(runBootstrap(withInitialUser, MONGO_REGISTERED, REGISTERED_API).ok).toBe(true);
    const after = dump(MONGO_REGISTERED);
    expect(after.connections).toEqual(aged.connections);
    expect(after.sources).toEqual(aged.sources);
    // HyperDX named this Team and no teamName was given: its name stays.
    expect(after.teams[0]?.name).toBe(`${ADMIN.email}'s Team`);
    const marker = after.typekro_bootstrap.find((doc) =>
      String(doc._id).startsWith('team-defaults:')
    );
    expect(marker?.state).toBe('complete');
    expect(marker?.seeded).toBe(false);
  });

  it('gives a signed-in user a connection and sources, so HyperDX shows no setup modal, and search works', async () => {
    const cookie = await signIn(legacyUrl, LEGACY_USER);
    // The onboarding modal opens on an empty /connections, then on an empty /sources.
    const connections = await api<Array<{ id: string; name: string; host: string }>>(
      legacyUrl,
      cookie,
      '/connections'
    );
    const sources = await api<Array<{ id: string; name: string; kind: string }>>(
      legacyUrl,
      cookie,
      '/sources'
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]?.name).toBe('External ClickHouse');
    expect(connections[0]?.host).toBe(`http://${CLICKHOUSE}:8123`);
    expect(sources.map((source) => source.kind).sort()).toEqual([
      'log',
      'metric',
      'session',
      'trace',
    ]);
    expect((await api<{ name: string }>(legacyUrl, cookie, '/team')).name).toBe('ClickStack');

    // The seeded connection's credentials work: query the Logs source's table
    // through HyperDX's ClickHouse proxy, as the search page does.
    const connectionId = connections[0]?.id ?? '';
    const search = await fetch(`${legacyUrl}/api/clickhouse-proxy/?default_format=JSON`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'x-hyperdx-connection-id': connectionId },
      body: "SELECT Body FROM default.otel_logs WHERE ServiceName = 'checkout'",
    });
    expect(search.status).toBe(200);
    expect(((await search.json()) as { data: Array<{ Body: string }> }).data).toEqual([
      { Body: 'order 42 placed' },
    ]);
  });

  it('never overwrites what a user edited in HyperDX, and never re-seeds what they deleted', async () => {
    const cookie = await signIn(legacyUrl, LEGACY_USER);
    const [connection] = await api<Record<string, unknown>[]>(legacyUrl, cookie, '/connections');
    const sources = await api<Record<string, any>[]>(legacyUrl, cookie, '/sources');
    const logs = sources.find((source) => source.name === 'Logs') ?? {};

    await api(legacyUrl, cookie, `/connections/${connection?.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...connection,
        name: 'Analytics ClickHouse',
        password: 'rotated-by-a-human',
      }),
    });
    await api(legacyUrl, cookie, `/sources/${logs.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...logs, defaultTableSelectExpression: 'Timestamp,Body' }),
    });
    await api(legacyUrl, cookie, '/team/name', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Platform Team' }),
    });

    const edited = dump(MONGO_LEGACY);
    expect(runBootstrap(degraded, MONGO_LEGACY).ok).toBe(true);
    const afterRun = dump(MONGO_LEGACY);
    expect(afterRun.teams).toEqual(edited.teams);
    expect(afterRun.connections).toEqual(edited.connections);
    expect(afterRun.sources).toEqual(edited.sources);
    expect(afterRun.connections[0]?.name).toBe('Analytics ClickHouse');
    expect(afterRun.connections[0]?.password).toBe('rotated-by-a-human');
    expect(afterRun.teams[0]?.name).toBe('Platform Team');

    // Deleted on purpose: stays deleted.
    for (const source of sources)
      await api(legacyUrl, cookie, `/sources/${source.id}`, { method: 'DELETE' });
    await api(legacyUrl, cookie, `/connections/${connection?.id}`, { method: 'DELETE' });
    expect(runBootstrap(degraded, MONGO_LEGACY).ok).toBe(true);
    expect(await api<unknown[]>(legacyUrl, cookie, '/connections')).toEqual([]);
    expect(await api<unknown[]>(legacyUrl, cookie, '/sources')).toEqual([]);
  });

  it('applies a changed teamName, but not over a rename made in HyperDX', () => {
    const renamed = render({ teamName: 'Observability' });
    // The Team is 'Platform Team' from the UI, not the 'ClickStack' TypeKro last applied.
    const run = runBootstrap(renamed, MONGO_LEGACY);
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain('renamed in HyperDX to "Platform Team" after TypeKro named it');
    expect(dump(MONGO_LEGACY).teams[0]?.name).toBe('Platform Team');

    // On the fresh instance nobody renamed it, so the new option applies.
    expect(runBootstrap(renamed, MONGO_FRESH).ok).toBe(true);
    const fresh = dump(MONGO_FRESH);
    expect(fresh.teams[0]?.name).toBe('Observability');
    expect(fresh.connections).toHaveLength(1);
    expect(fresh.sources).toHaveLength(4);
  });
});
