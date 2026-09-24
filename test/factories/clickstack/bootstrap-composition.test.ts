/**
 * ClickStack bootstrap composition — serialization tests (no cluster).
 *
 * Runs under TYPEKRO_STRICT_CEL=1: the strict gate must accept every status
 * CEL this composition emits (the loud-diagnostic contract).
 *
 * Covers the #93-review rules as applied here:
 *  - build-time vs runtime split (`makeClickstackBootstrap` variants; loud
 *    ref rejection on build-time options),
 *  - the hard pins beating any values passthrough IN THE SERIALIZED OUTPUT
 *    (`clickhouse.enabled: false`, `mongodb.enabled: false`),
 *  - the Mongo mode variants shaping WHICH resources exist,
 *  - the typed status service contract (ui/gateway/app endpoints).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';

import {
  clickstackBootstrap,
  makeClickstackBootstrap,
  renderClickStackTeamBootstrapScript,
} from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import {
  CLICKSTACK_API_PORT,
  DEFAULT_CLICKSTACK_VERSION,
} from '../../../src/factories/clickstack/resources/helm.js';
import {
  type ResolvedClickStackInitialUser,
  CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION,
  CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV,
  CLICKSTACK_INITIAL_USER_MARKER_ID,
  CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS,
  ClickStackBootstrapStatusSchema,
  DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY,
  isClickStackInitialUserValidatedChartVersion,
} from '../../../src/factories/clickstack/types.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

/** Concrete direct-mode spec used by the chart-version guard tests. */
const BOOTSTRAP_SPEC_FOR_VERSION_GUARD = {
  name: 'clickstack',
  namespace: 'clickstack',
  clickhouse: {
    host: 'clickhouse-observability.clickhouse.svc.cluster.local',
    username: 'otelcollector',
    password: 'collector-pw',
  },
  apiKey: 'test-ingestion-api-key',
} as const;

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

/** A fake schema-proxy ref, shaped like the analyzer's KubernetesRef marker. */
function fakeRef(path: string): unknown {
  return { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: path };
}

describe('clickstackBootstrap (internal-Mongo default)', () => {
  it('preserves the internal Mongo URI as a canonical plan template', () => {
    const plan = clickstackBootstrap.plan!(
      {
        name: 'clickstack',
        namespace: 'observability',
        clickhouse: {
          host: 'clickhouse.observability.svc.cluster.local',
          username: 'otelcollector',
          password: 'test-only',
        },
        apiKey: 'test-only',
      },
      { strict: true }
    );
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toContain('[object Object]');
    expect(serialized).toContain('.svc.cluster.local:27017/hyperdx');
  });

  it('serializes an RGD wrapping the official clickstack chart under strict CEL', () => {
    const yaml = clickstackBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRelease');
    // The official chart, by name — never hdx-oss-v2 / the archived repo.
    expect(yaml).toContain('chart: clickstack');
    expect(yaml).not.toContain('hdx-oss-v2');
    // The internal Mongo variant carries its StatefulSet + Service.
    expect(yaml).toContain('kind: StatefulSet');
    expect(yaml).toContain('mongo:7');
  });

  it('hard-pins the bundled clickhouse + mongodb OFF in the serialized values', () => {
    const yaml = clickstackBootstrap.toYaml();
    // The pins live under values.clickhouse.enabled / values.mongodb.enabled.
    // Serialized YAML nests them; assert the pinned `enabled: false` blocks exist
    // and no `enabled: true` appears for either subchart key.
    expect(yaml).toMatch(/clickhouse:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/mongodb:\s*\n\s+enabled: false/);
  });

  it('the pins beat a build-time values passthrough trying to re-enable the subcharts', () => {
    const subverted = makeClickstackBootstrap({
      values: { clickhouse: { enabled: true }, mongodb: { enabled: true } },
      name: 'clickstack-subverted',
      kind: 'ClickstackSubverted',
    });
    const yaml = subverted.toYaml();
    expect(yaml).toMatch(/clickhouse:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/mongodb:\s*\n\s+enabled: false/);
    expect(yaml).not.toMatch(/clickhouse:\s*\n\s+enabled: true/);
    expect(yaml).not.toMatch(/mongodb:\s*\n\s+enabled: true/);
  });

  it('serializes the connection contract into KRO status as CEL over the owned HelmRelease', () => {
    const yaml = clickstackBootstrap.toYaml();
    const documents = yaml
      .split(/^---$/m)
      .map((document) => document.trim())
      .filter(Boolean)
      .map((document) => load(document) as Record<string, unknown>);
    const root = documents.find((document) => {
      const spec = document.spec as { schema?: { kind?: string } } | undefined;
      return (
        document.kind === 'ResourceGraphDefinition' && spec?.schema?.kind === 'ClickStackBootstrap'
      );
    }) as { spec: { schema: { status: Record<string, unknown> } } };
    const status = root.spec.schema.status as {
      ui: { url: string };
      gateway: { otlpHttpEndpoint: string; otlpGrpcEndpoint: string };
      app: { host: string };
    };
    // Resource-derived fields serialize as KRO CEL off the owned HelmRelease...
    expect(yaml).toContain('clickstackHelmRelease.status.observedGeneration');
    expect(yaml).toContain('clickstackTeamBootstrap.status.lastScheduleTime');
    expect(yaml).toContain('clickstackTeamBootstrap.status.lastSuccessfulTime');
    expect(yaml).toContain('phase:');
    // ...and so does the CONNECTION CONTRACT (ui/gateway/app): it is anchored
    // on the HelmRelease resource (raw CEL over clickstackHelmRelease.metadata,
    // fullnameOverride-pinned naming, chart-default ports inside the URL
    // strings), so GitOps/KRO consumers see it on the live KRO CR's status.
    // (Same reachability class as the PR #93 review finding — a spec-derived
    // or metadata-proxy derivation would be client-hydrated and dropped.)
    expect(status.ui.url).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:3000'
    );
    expect(status.gateway.otlpHttpEndpoint).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4318'
    );
    expect(status.gateway.otlpGrpcEndpoint).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4317'
    );
    expect(status.app.host).toBe(
      '${string(clickstackHelmRelease.metadata.name)}.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local'
    );
    // KRO status CEL can never reference schema.spec.*.
    expect(JSON.stringify(status)).not.toContain('schema.spec');

    const projected = root.spec.schema.status as {
      version: string;
      app: { appPort: string; apiPort: string };
      storage: { mode: string; persistentQueue: string };
    };
    // `version` is the chart pin on the OWNED HelmRelease — a resource
    // projection whose path repeats `spec`. The RGD validator used to read that
    // second segment as a resource id ("Referenced resource 'chart' does not
    // exist") and the composition echoed the value through the contract
    // ConfigMap instead; the fix is in the core scanner, so this is the direct
    // anchor again.
    expect(projected.version).toBe('${clickstackHelmRelease.spec.chart.spec.version}');

    // The remaining CONSTRUCTION-TIME fields (the ports, the storage block)
    // have no owned resource that already carries them, so they are projected
    // from the contract ConfigMap this composition owns — reaching the live CR
    // instead of being literals KRO drops. ConfigMap values are strings, so the
    // ports come back through `int(...)`.
    expect(projected.app.appPort).toBe('${int(clickstackContract.data.appPort)}');
    expect(projected.app.apiPort).toBe('${int(clickstackContract.data.apiPort)}');
    expect(projected.storage.mode).toBe('${clickstackContract.data.storageMode}');
    expect(projected.storage.persistentQueue).toBe(
      '${clickstackContract.data.storagePersistentQueue == "true"}'
    );

    // EVERY declared status leaf is a resource projection — no literal leaf
    // survives to promise a field the instance CR will not carry.
    const leaves: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value)) walk(nested);
      } else {
        leaves.push(String(value));
      }
    };
    walk(status);
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(leaf).toMatch(/\$\{/);
    }

    // The typed contract itself is declared on the status schema (client-hydrated fields included).
    const valid = ClickStackBootstrapStatusSchema({
      ready: true,
      phase: 'Ready',
      ui: { url: 'http://clickstack.clickstack.svc.cluster.local:3000' },
      gateway: {
        otlpHttpEndpoint: 'http://clickstack-otel-collector.clickstack.svc.cluster.local:4318',
        otlpGrpcEndpoint: 'http://clickstack-otel-collector.clickstack.svc.cluster.local:4317',
      },
      app: { host: 'clickstack.clickstack.svc.cluster.local', appPort: 3000, apiPort: 8000 },
    });
    expect(valid).not.toBeInstanceOf(Error);
    // A contract missing the gateway block is rejected.
    const invalid = ClickStackBootstrapStatusSchema({ ready: true, phase: 'Ready' } as never);
    expect(String(invalid)).toContain('gateway');
  });
});

describe('makeClickstackBootstrap (build-time variants)', () => {
  it('external-Mongo variant drops the internal Mongo resources and requires mongoUri in the spec schema', () => {
    const external = makeClickstackBootstrap({
      mongo: { mode: 'external' },
      name: 'clickstack-external-mongo',
      kind: 'ClickstackExternalMongo',
    });
    const yaml = external.toYaml();
    expect(yaml).not.toContain('kind: StatefulSet');
    expect(yaml).toContain('kind: CronJob');
    expect(yaml).toContain('${schema.spec.mongoUri}');
    // The variant's spec schema requires the URI (topology shapes the schema).
    expect(yaml).toContain('mongoUri');
  });

  it('rejects schema refs in build-time options with an actionable error', () => {
    expect(() =>
      makeClickstackBootstrap({
        // Build-time raw values must be concrete — a ref here can never serialize.
        values: { hyperdx: { replicas: fakeRef('spec.replicas') } } as never,
        name: 'clickstack-ref-values',
        kind: 'ClickstackRefValues',
      })
    ).toThrow(/build-time|concrete|constructor/i);
  });
});

/**
 * A minimal in-memory stand-in for the `db` global mongosh hands the script.
 *
 * WHY EXECUTE THE SCRIPT AT ALL. String-matching the rendered text proves the
 * renderer emits the lines we wrote; it cannot prove the CONTROL FLOW is what
 * the safety argument claims — that a deliberately deleted account is not
 * resurrected, that a missing Secret key still lets the Team converge, that a
 * marker short-circuits before anything is touched. Those are behaviours, so
 * the tests below run the real script against this shim and assert on the
 * resulting collections.
 *
 * It implements only what the script uses: top-level field equality matching,
 * `find().toArray()`, `findOne`, `insertOne`, `countDocuments`, and
 * `updateOne` with `$set` / `$setOnInsert` + `upsert`.
 */
interface FakeCollection {
  documents: Record<string, unknown>[];
  reads: number;
  writes: number;
}

function createFakeMongo() {
  const collections = new Map<string, FakeCollection>();

  const collectionFor = (name: string): FakeCollection => {
    const existing = collections.get(name);
    if (existing !== undefined) return existing;
    const created: FakeCollection = { documents: [], reads: 0, writes: 0 };
    collections.set(name, created);
    return created;
  };

  const matches = (document: Record<string, unknown>, query: Record<string, unknown>): boolean =>
    Object.entries(query).every(([key, value]) => document[key] === value);

  const wrap = (name: string) => {
    const collection = collectionFor(name);
    return {
      find(query: Record<string, unknown> = {}) {
        collection.reads += 1;
        return { toArray: () => collection.documents.filter((doc) => matches(doc, query)) };
      },
      findOne(query: Record<string, unknown> = {}) {
        collection.reads += 1;
        return collection.documents.find((doc) => matches(doc, query)) ?? null;
      },
      countDocuments(query: Record<string, unknown> = {}) {
        collection.reads += 1;
        return collection.documents.filter((doc) => matches(doc, query)).length;
      },
      insertOne(document: Record<string, unknown>) {
        collection.writes += 1;
        collection.documents.push({ _id: `oid-${collection.documents.length}`, ...document });
      },
      updateOne(
        filter: Record<string, unknown>,
        update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
        options?: { upsert?: boolean }
      ) {
        const existing = collection.documents.find((doc) => matches(doc, filter));
        if (existing !== undefined) {
          if (update.$set !== undefined) {
            collection.writes += 1;
            Object.assign(existing, update.$set);
          }
          // `$setOnInsert` on an existing document is deliberately a no-op —
          // that is exactly why the marker is never restamped.
          return;
        }
        if (options?.upsert === true) {
          collection.writes += 1;
          collection.documents.push({ ...filter, ...update.$setOnInsert, ...update.$set });
        }
      },
    };
  };

  // `database.<name>` is property access in the script, so the sibling DB has
  // to materialise collections on demand.
  const database = new Proxy({} as Record<string, ReturnType<typeof wrap>>, {
    get: (_target, property: string) => wrap(property),
  });

  return {
    db: { getSiblingDB: () => database },
    collection: (name: string) => collectionFor(name),
    documentsIn: (name: string) => collectionFor(name).documents,
  };
}

/**
 * A recording stand-in for the `fetch` mongosh exposes.
 *
 * WHY A FAKE HTTP LAYER AND NOT A STRING MATCH. The whole design now rests on
 * what the script does with the ANSWER: a 200 claims the instance, a 409 means
 * somebody else claimed it and is therefore a success, a 4xx must abort without
 * writing a marker, and a connection failure must read as "not up yet" rather
 * than as a fault. None of that is visible in the script's text, so the tests
 * below execute it against this.
 */
interface FakeFetchCall {
  url: string;
  method: string;
  redirect: string;
  headers: Record<string, string>;
  body: unknown;
}

function createFakeFetch(
  respond: (call: FakeFetchCall) => { status: number; body: string; location?: string } | Error
) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = async (
    url: string,
    init: { method?: string; redirect?: string; headers?: Record<string, string>; body?: string } = {}
  ) => {
    const call: FakeFetchCall = {
      url,
      method: init.method ?? 'GET',
      redirect: init.redirect ?? 'follow',
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const outcome = respond(call);
    // `fetch` REJECTS on a transport failure; it does not resolve with a status.
    if (outcome instanceof Error) throw outcome;
    return {
      status: outcome.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? (outcome.location ?? null) : null) },
      text: async () => outcome.body,
    };
  };
  return { fetch: fetchImpl, calls };
}

/** A fake that always accepts the registration, the way a live API would. */
function acceptingFetch() {
  return createFakeFetch(() => ({ status: 200, body: '{"status":"success"}' }));
}

/**
 * Run a rendered script the way mongosh does.
 *
 * mongosh resolves a promise returned by the last expression of `--eval` and
 * exits non-zero when it rejects, but it does NOT accept top-level `await` —
 * which is why the rendered script is one async function invoked at the end,
 * and why this returns the promise that function produced.
 */
function runBootstrapScript(
  script: string,
  environment: Record<string, string | undefined>,
  mongo: ReturnType<typeof createFakeMongo>,
  fetchImpl: (url: string, init?: unknown) => Promise<unknown> = acceptingFetch().fetch as never
): Promise<unknown> {
  // A direct `eval` yields the COMPLETION VALUE of the last statement and sees
  // this function's parameters as its scope — which is exactly how mongosh
  // treats an `--eval` program and the globals it injects into it.
  const run = new Function(
    'db',
    'process',
    'require',
    'fetch',
    'print',
    '__script',
    'return eval(__script);'
  ) as (
    db: unknown,
    proc: unknown,
    req: unknown,
    fetchFn: unknown,
    printFn: unknown,
    src: string
  ) => unknown;
  const result = run(
    mongo.db,
    { env: environment },
    (module: string) => {
      throw new Error(`unexpected require(${module})`);
    },
    fetchImpl,
    () => {},
    script
  );
  return Promise.resolve(result);
}

const VALID_API_KEY = '11111111-2222-3333-4444-555555555555';

/**
 * A password the endpoint would accept. TypeKro no longer has an opinion about
 * it — `/register/password` enforces its own policy — so this exists only so
 * the fixtures read like real ones.
 */
const REALISTIC_PASSWORD = 'Bootstrap1!secret';

const API_BASE_URL = 'http://clickstack.clickstack.svc.cluster.local:8000';

function resolvedInitialUser(
  overrides: Partial<ResolvedClickStackInitialUser> = {}
): ResolvedClickStackInitialUser {
  return {
    email: 'ops@example.com',
    passwordSecretName: 'clickstack-secret',
    passwordSecretKey: DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY,
    passwordEnvVarName: DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY,
    allowUnvalidatedChartVersion: false,
    ...overrides,
  };
}

/** The environment the CronJob container gives the configured script. */
const CONFIGURED_ENVIRONMENT = {
  HYPERDX_API_KEY: VALID_API_KEY,
  [CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV]: API_BASE_URL,
  [DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY]: REALISTIC_PASSWORD,
};

/**
 * The initial user (#227), built on HyperDX's OWN registration endpoint.
 *
 * THE UPSTREAM INVARIANT these tests defend: HyperDX hands out exactly one
 * registration per instance. `POST /register/password` creates the first
 * account AND its Team AND (through `setupTeamDefaults`) that Team's connection
 * and sources, then answers 409 `teamAlreadyExists` forever. Whoever spends
 * that registration becomes the administrator. TypeKro's CronJob used to spend
 * it by creating the Team directly and produce no account at all.
 */
describe('clickstackBootstrap initialUser (#227)', () => {
  const INITIAL_USER = { email: 'ops@example.com' } as const;

  it('leaves the degraded script untouched when initialUser is not configured', () => {
    const script = renderClickStackTeamBootstrapScript();

    // Nothing about registration may leak into the unconfigured deployment…
    expect(script).not.toContain('register/password');
    expect(script).not.toContain('fetch');
    expect(script).not.toContain(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION);
    expect(script).not.toContain(DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY);
    expect(script).not.toContain(CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV);
    // …and it still creates the Team itself, which is the degraded behaviour.
    expect(script).toContain("const hookId = 'typekro-managed-ingestion';");
    expect(script).toContain('database.teams.insertOne({');
  });

  it('never creates the Team itself when initialUser IS configured', () => {
    const script = renderClickStackTeamBootstrapScript(resolvedInitialUser());

    // THE POINT OF THE REWRITE. Creating the Team is what consumes HyperDX's
    // single registration. The configured script must not contain that write
    // at all — the registration endpoint creates the Team as a side effect of
    // creating the account.
    expect(script).not.toContain('database.teams.insertOne');
    expect(script).not.toContain('typekro-managed-ingestion');
    expect(script).toContain("await fetch(apiBaseUrl + '/register/password'");
  });

  it('reproduces none of HyperDX private user schema', () => {
    const script = renderClickStackTeamBootstrapScript(resolvedInitialUser());

    // Everything the previous design hand-built is now the app's own work.
    expect(script).not.toContain('pbkdf2');
    expect(script).not.toContain('salt');
    expect(script).not.toContain('hash');
    expect(script).not.toContain('accessKey');
    expect(script).not.toContain('database.users.insertOne');
    expect(script).not.toContain("require('crypto')");
    // The ONLY remaining write into an upstream-owned document.
    expect(script).toContain('database.teams.updateOne({ _id: teams[0]._id }, {');
    expect(script.match(/database\.teams\.updateOne/g)).toHaveLength(1);
  });

  it('posts the address and the Secret password, and embeds neither in the manifest', async () => {
    const mongo = createFakeMongo();
    const http = createFakeFetch(() => {
      mongo.collection('teams').documents.push({ _id: 'team-1' });
      return { status: 200, body: '{"status":"success"}' };
    });
    const script = renderClickStackTeamBootstrapScript(resolvedInitialUser());

    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(`${API_BASE_URL}/register/password`);
    expect(http.calls[0]?.method).toBe('POST');
    expect(http.calls[0]?.headers['content-type']).toBe('application/json');
    // A refusal redirects to the login page; following it would read as a 200.
    expect(http.calls[0]?.redirect).toBe('manual');
    // `confirmPassword` is required by `registrationSchema` — omitting it is a
    // 400, so the script must send it.
    expect(http.calls[0]?.body).toEqual({
      email: 'ops@example.com',
      password: REALISTIC_PASSWORD,
      confirmPassword: REALISTIC_PASSWORD,
    });
    // The password is read from the environment, never rendered into the text.
    expect(script).toContain(
      `const initialUserPassword = process.env.${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY};`
    );
    expect(script).not.toContain(REALISTIC_PASSWORD);
  });

  it('patches the ingestion key onto the Team the registration created', async () => {
    const mongo = createFakeMongo();
    // What `/register/password` does on the other side of the call.
    const http = createFakeFetch(() => {
      mongo.collection('teams').documents.push({ _id: 'team-1', name: 'My Team' });
      return { status: 200, body: '{"status":"success"}' };
    });

    await runBootstrapScript(
      renderClickStackTeamBootstrapScript(resolvedInitialUser()),
      CONFIGURED_ENVIRONMENT,
      mongo,
      http.fetch as never
    );

    expect(mongo.documentsIn('teams')).toHaveLength(1);
    expect(mongo.documentsIn('teams')[0]?.apiKey).toBe(VALID_API_KEY);
    expect(mongo.documentsIn('teams')[0]?.collectorAuthenticationEnforced).toBe(true);
    // The team the APP created, not one TypeKro replaced.
    expect(mongo.documentsIn('teams')[0]?.name).toBe('My Team');
  });

  it('does not lowercase or otherwise rewrite the address it was given', () => {
    // The HyperDX user model registers passport-local-mongoose with
    // `usernameLowerCase`, so the APP normalises the address. TypeKro doing it
    // too would be one more assumption about private behaviour for no gain.
    const script = renderClickStackTeamBootstrapScript(
      resolvedInitialUser({ email: 'Ops@Example.COM' })
    );
    expect(script).toContain('const initialUserEmail = "Ops@Example.COM";');
  });

  it('accepts addresses the removed regex rejected, because the endpoint decides', () => {
    // The custom pattern diverged from `registrationSchema` in both directions.
    // Now the endpoint is the only authority and answers 400 with the field
    // named, so TypeKro checks presence and nothing else.
    for (const email of ['ops+tag@example.com', 'ops@localhost', "o'brien@example.com"]) {
      expect(() => makeClickstackBootstrap({ initialUser: { email } })).not.toThrow();
    }
  });

  it('still rejects an empty address, which could only produce a failed run', () => {
    expect(() => makeClickstackBootstrap({ initialUser: { email: '   ' } })).toThrow(
      /initialUser\.email is required/
    );
  });

  it('rejects a passwordSecretKey that is not a POSIX environment variable name', () => {
    expect(() =>
      makeClickstackBootstrap({
        initialUser: { email: 'ops@example.com', passwordSecretKey: 'not a var' },
      })
    ).toThrow(/POSIX environment variable name/);
    expect(() =>
      makeClickstackBootstrap({
        initialUser: { email: 'ops@example.com', passwordSecretKey: '9LEADING_DIGIT' },
      })
    ).toThrow(/POSIX environment variable name/);
  });

  it('serializes the registration into the RGD (kro mode) with an optional secretKeyRef', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: INITIAL_USER,
      name: 'clickstack-initial-user',
      kind: 'ClickstackInitialUser',
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('register/password');
    expect(yaml).toContain(`key: ${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY}`);
    expect(yaml).toContain(`name: ${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY}`);
    expect(yaml).toContain('name: clickstack-secret');
    // The password is a Secret reference, never a schema field.
    expect(yaml).not.toContain('schema.spec.initialUser');
    expect(yaml).not.toContain('initialUserPassword:');
  });

  it('carries the registration on the external-Mongo variant too', () => {
    const external = makeClickstackBootstrap({
      mongo: { mode: 'external' },
      initialUser: { email: 'ops@example.com', passwordSecretKey: 'HYPERDX_SEED_PASSWORD' },
      name: 'clickstack-initial-user-external',
      kind: 'ClickstackInitialUserExternal',
    });
    const yaml = external.toYaml();

    expect(yaml).toContain('register/password');
    expect(yaml).toContain('key: HYPERDX_SEED_PASSWORD');
    expect(yaml).not.toContain('HYPERDX_INITIAL_USER_PASSWORD');
  });
});

/**
 * The API base URL is DERIVED, not hardcoded.
 *
 * The script is build-time text but the release name and namespace are runtime
 * values, so the URL cannot be baked in — it rides as an environment value
 * built from the composition's own naming and API port, exactly as the Mongo
 * URI does.
 */
describe('clickstackBootstrap initialUser API endpoint', () => {
  it('derives the base URL from the release naming and the composition API port', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-api-url',
      kind: 'ClickstackApiUrl',
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain(`name: ${CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV}`);
    // A CEL template over the runtime release name and namespace — the same
    // shape the Mongo URI uses — resolving against the composition's own port.
    expect(yaml).toContain('http://${schema.spec.name}.');
    expect(yaml).toContain(`.svc.cluster.local:${CLICKSTACK_API_PORT}`);
  });

  it('adds no API URL at all when initialUser is unconfigured', () => {
    expect(clickstackBootstrap.toYaml()).not.toContain(
      CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV
    );
  });
});

/**
 * Bootstrap-once semantics, EXECUTED.
 *
 * `countDocuments({}) === 0` answers "does something exist right now?" — not
 * "has TypeKro ever bootstrapped?". The durable marker in `typekro_bootstrap`
 * is what makes the claim true, so these tests run the script rather than
 * reading it.
 */
describe('clickstackBootstrap initialUser bootstrap-once marker', () => {
  const script = renderClickStackTeamBootstrapScript(resolvedInitialUser());

  /** A fake that registers the way the real endpoint does: creating the Team. */
  const registeringFetch = (mongo: ReturnType<typeof createFakeMongo>) =>
    createFakeFetch(() => {
      mongo.collection('teams').documents.push({ _id: 'team-1', name: 'My Team' });
      return { status: 200, body: '{"status":"success"}' };
    });

  it('registers once and records the marker on the first run', async () => {
    const mongo = createFakeMongo();
    const http = registeringFetch(mongo);
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    expect(http.calls).toHaveLength(1);
    const markers = mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION);
    expect(markers).toHaveLength(1);
    expect(markers[0]?._id).toBe(CLICKSTACK_INITIAL_USER_MARKER_ID);
    expect(markers[0]?.completed).toBe(true);
    expect(markers[0]?.completedAt).toBeInstanceOf(Date);
  });

  it('never registers twice, however often the CronJob runs', async () => {
    const mongo = createFakeMongo();
    const http = registeringFetch(mongo);
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    expect(http.calls).toHaveLength(1);
    expect(mongo.documentsIn('teams')).toHaveLength(1);
  });

  it('treats 409 teamAlreadyExists as already bootstrapped, and still writes the marker', async () => {
    const mongo = createFakeMongo();
    // The race the invariant makes possible: no Team when the script looked,
    // a human registering before the POST lands.
    const http = createFakeFetch(() => {
      mongo.collection('teams').documents.push({ _id: 'team-human', name: 'Human Team' });
      return { status: 409, body: '{"error":"teamAlreadyExists"}' };
    });

    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    // Not an error: the instance is claimed, which is the objective.
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(1);
    // …and the ingestion key still lands on the human's Team.
    expect(mongo.documentsIn('teams')[0]?.apiKey).toBe(VALID_API_KEY);
  });

  it('does not register when a Team already exists, and closes the question', async () => {
    const mongo = createFakeMongo();
    mongo.collection('teams').documents.push({ _id: 'team-human', name: 'Human Team' });
    const http = acceptingFetch();

    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    expect(http.calls).toHaveLength(0);
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(1);
    expect(mongo.documentsIn('teams')[0]?.apiKey).toBe(VALID_API_KEY);
  });

  it('short-circuits before the network or the password once the marker exists', async () => {
    const mongo = createFakeMongo();
    mongo.collection('teams').documents.push({ _id: 'team-1', apiKey: VALID_API_KEY, collectorAuthenticationEnforced: true });
    mongo.collection(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION).documents.push({
      _id: CLICKSTACK_INITIAL_USER_MARKER_ID,
      completed: true,
      completedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const http = acceptingFetch();

    // No password in the environment at all: the short-circuit must happen
    // before anything looks for one.
    await runBootstrapScript(
      script,
      {
        HYPERDX_API_KEY: VALID_API_KEY,
        [CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV]: API_BASE_URL,
      },
      mongo,
      http.fetch as never
    );

    expect(http.calls).toHaveLength(0);
    // The marker is not restamped — `$setOnInsert`, not `$set`.
    const markers = mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.completedAt).toEqual(new Date('2020-01-01T00:00:00.000Z'));
  });

  it('refuses to recreate a Team deleted after bootstrap, rather than spending a registration nobody can use', async () => {
    const mongo = createFakeMongo();
    const http = registeringFetch(mongo);
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    // The operator tears the Team down on purpose.
    mongo.collection('teams').documents.length = 0;

    await expect(
      runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never)
    ).rejects.toThrow(/no HyperDX Team exists yet/);
    // No new registration was attempted, and none was silently recreated.
    expect(http.calls).toHaveLength(1);
    expect(mongo.documentsIn('teams')).toHaveLength(0);
  });
});

/**
 * The transient and the genuinely broken, told apart.
 *
 * The CronJob runs every minute and depends on the HelmRelease, so an API that
 * has not finished starting is the NORMAL case on the first few runs. It must
 * not read like a fault, and a real refusal must not read like a transient.
 */
describe('clickstackBootstrap initialUser failure modes', () => {
  const script = renderClickStackTeamBootstrapScript(resolvedInitialUser());

  it('reports an unreachable API as the transient it is', async () => {
    const mongo = createFakeMongo();
    // What `fetch` actually does when nothing is listening: it REJECTS.
    const http = createFakeFetch(() => new TypeError('fetch failed'));

    const failure = runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    await expect(failure).rejects.toThrow(/is not reachable yet/);
    await expect(failure).rejects.toThrow(/the CronJob retries every minute/);
    // Nothing was recorded, so the next run genuinely retries.
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(0);
  });

  it('relays the endpoint own rejection instead of second-guessing its rules', async () => {
    const mongo = createFakeMongo();
    const http = createFakeFetch(() => ({
      status: 400,
      body: '[{"errors":{"issues":[{"message":"Password must have at least 12 characters"}]}}]',
    }));

    const failure = runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    // The operator gets HyperDX's own words, which name the offending field.
    await expect(failure).rejects.toThrow(/Password must have at least 12 characters/);
    await expect(failure).rejects.toThrow(/HTTP 400/);
    // And the reassurance that matters: a refused registration is not a
    // consumed one, so the single registration is still available.
    await expect(failure).rejects.toThrow(/no registration was consumed/);
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(0);
  });

  it('treats a redirect as a refusal, never as a registration, and writes no marker', async () => {
    // hyperdxOidc with passwordLogin: false refuses a registration it does not
    // admit with a 303 to the login page (e.g. the HyperDX pod has not synced
    // a just-added Secret key yet).
    const mongo = createFakeMongo();
    const http = createFakeFetch(() => ({
      status: 303,
      body: '',
      location: 'https://hyperdx.example.com/login?err=passwordAuthNotAllowed',
    }));

    const failure = runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    await expect(failure).rejects.toThrow(/HTTP 303 to https:\/\/hyperdx\.example\.com\/login\?err=passwordAuthNotAllowed/);
    await expect(failure).rejects.toThrow(/No registration was consumed; the CronJob retries/);
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(0);
  });

  it('fails with a readable message when registration is needed but the key is absent', async () => {
    const mongo = createFakeMongo();
    const http = acceptingFetch();

    await expect(
      runBootstrapScript(
        script,
        {
          HYPERDX_API_KEY: VALID_API_KEY,
          [CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV]: API_BASE_URL,
        },
        mongo,
        http.fetch as never
      )
    ).rejects.toThrow(
      new RegExp(
        `${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY} is required to register the initial HyperDX user`
      )
    );

    expect(http.calls).toHaveLength(0);
    expect(mongo.documentsIn(CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION)).toHaveLength(0);
  });

  it('keeps reconciling the ingestion key after the bootstrap password is rotated away', async () => {
    const mongo = createFakeMongo();
    const http = createFakeFetch(() => {
      mongo.collection('teams').documents.push({ _id: 'team-1' });
      return { status: 200, body: '{"status":"success"}' };
    });
    await runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, http.fetch as never);

    // The bootstrap credential is removed from the Secret afterwards and the
    // ingestion key rotates. Reconciliation must keep converging.
    const rotatedApiKey = '99999999-8888-7777-6666-555555555555';
    await runBootstrapScript(
      script,
      {
        HYPERDX_API_KEY: rotatedApiKey,
        [CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV]: API_BASE_URL,
      },
      mongo,
      http.fetch as never
    );
    expect(mongo.documentsIn('teams')[0]?.apiKey).toBe(rotatedApiKey);
  });

  it('refuses to guess which Team owns the ingestion key when several exist', async () => {
    const mongo = createFakeMongo();
    mongo.collection('teams').documents.push({ _id: 'a' }, { _id: 'b' });

    await expect(
      runBootstrapScript(script, CONFIGURED_ENVIRONMENT, mongo, acceptingFetch().fetch as never)
    ).rejects.toThrow(/Multiple HyperDX Teams exist/);
  });

  it('wires the password reference as optional and the API key as required', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-optional-password',
      kind: 'ClickstackOptionalPassword',
    });
    const yaml = bootstrap.toYaml();

    // Both refs are on the same Secret, but their lifecycles differ: the
    // ingestion key is continuously required, the bootstrap password is not.
    expect(yaml).toContain('optional: true');
    expect(yaml).toContain('optional: false');
  });
});

/**
 * An externally-owned password Secret.
 *
 * In the inline credential mode there is no clean route into the chart's own
 * `clickstack-secret`: build-time `values.hyperdx.secrets` would put the
 * password in the HelmRelease `spec.values` tree, undoing the point of keeping
 * it out of a prop. `passwordSecretRef` names a Secret the operator owns.
 */
describe('clickstackBootstrap initialUser passwordSecretRef', () => {
  it('reads from the named Secret with a fixed environment variable', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: {
        email: 'ops@example.com',
        passwordSecretRef: { name: 'hyperdx-bootstrap', key: 'initial-user.password' },
      },
      name: 'clickstack-external-password',
      kind: 'ClickstackExternalPassword',
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain('name: hyperdx-bootstrap');
    expect(yaml).toContain('key: initial-user.password');
    // A Secret key may contain `-` and `.`, which a POSIX env-var name may not,
    // so the container variable is the fixed default.
    expect(yaml).toContain(`name: ${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY}`);
    expect(yaml).toContain(
      `const initialUserPassword = process.env.${DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY};`
    );
  });

  it('is mutually exclusive with passwordSecretKey', () => {
    expect(() =>
      makeClickstackBootstrap({
        initialUser: {
          email: 'ops@example.com',
          passwordSecretKey: 'HYPERDX_INITIAL_USER_PASSWORD',
          passwordSecretRef: { name: 'hyperdx-bootstrap', key: 'password' },
        },
      })
    ).toThrow(/mutually exclusive/);
  });

  it('still defaults to the chart-owned Secret when neither is given', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-default-secret',
      kind: 'ClickstackDefaultSecret',
    });
    expect(bootstrap.toYaml()).toContain('name: clickstack-secret');
  });
});

/**
 * Secret name and key syntax, against KUBERNETES' REAL RULES.
 *
 * A local approximation of these is wrong in a direction nobody notices: a key
 * that passes a hand-rolled character class but is 300 characters long, or is
 * literally `..`, is accepted at build time and rejected by the API server at
 * apply time — the failure lands on a cluster instead of next to the call. One
 * shared validator (`validateSecretDataKey` / `validateDnsSubdomainName`)
 * carries all four checks for every caller.
 */
describe('clickstackBootstrap initialUser Secret reference syntax', () => {
  const withRef = (name: string, key: string) => () =>
    makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com', passwordSecretRef: { name, key } },
    });

  it('accepts the key characters Kubernetes accepts', () => {
    for (const key of ['password', 'initial-user.password', 'INITIAL_USER', 'a.b-c_d9', '.hidden']) {
      expect(withRef('hyperdx-bootstrap', key)).not.toThrow();
    }
  });

  it('rejects keys outside [-._a-zA-Z0-9]', () => {
    expect(withRef('hyperdx-bootstrap', 'not/a/key')).toThrow(/Secret data key/);
    expect(withRef('hyperdx-bootstrap', 'not a key')).toThrow(/Secret data key/);
    expect(withRef('hyperdx-bootstrap', '')).toThrow(/Secret data key/);
  });

  it('rejects the reserved path names a projected key would collide with', () => {
    // A key becomes a FILE NAME in a projected volume, so `.`, `..` and a
    // leading `..` are refused by the API server outright.
    expect(withRef('hyperdx-bootstrap', '.')).toThrow(/must not be '\.' or '\.\.'/);
    expect(withRef('hyperdx-bootstrap', '..')).toThrow(/must not be '\.' or '\.\.'/);
    expect(withRef('hyperdx-bootstrap', '..data')).toThrow(/must not start with '\.\.'/);
  });

  it('bounds the key length at 253, the part a character class cannot express', () => {
    expect(withRef('hyperdx-bootstrap', 'a'.repeat(253))).not.toThrow();
    expect(withRef('hyperdx-bootstrap', 'a'.repeat(254))).toThrow(/at most 253 characters/);
  });

  it('holds the Secret NAME to RFC 1123 DNS subdomain rules', () => {
    expect(withRef('hyperdx.bootstrap-1', 'password')).not.toThrow();
    expect(withRef('Not A Name', 'password')).toThrow(/DNS subdomain/);
    expect(withRef('-leading-hyphen', 'password')).toThrow(/DNS subdomain/);
    expect(withRef('UPPERCASE', 'password')).toThrow(/DNS subdomain/);
    expect(withRef('a'.repeat(254), 'password')).toThrow(/at most 253 characters/);
  });

  it('bounds the chart-owned key too, where only the length rule was missing', () => {
    // A POSIX env-var name is STRICTER than a Secret data key on characters, so
    // the character half was already covered on this path; the length bound was
    // the part that was not.
    expect(() =>
      makeClickstackBootstrap({
        initialUser: { email: 'ops@example.com', passwordSecretKey: `A${'B'.repeat(253)}` },
      })
    ).toThrow(/at most 253 characters/);
  });
});

/**
 * The chart-version allowlist.
 *
 * WHAT IS STILL COUPLED. Registering through the app's own endpoint moved the
 * account document, its hashing and `setupTeamDefaults` off TypeKro entirely.
 * What remains is one write — `teams.apiKey` — into an upstream-owned schema,
 * plus the registration HTTP contract. The HTTP half fails LOUDLY if it moves
 * (a 404 turns the CronJob red); the `teams.apiKey` half does not, and that is
 * what the allowlist guards.
 *
 * WHY EXACT, AND WHY BOTH MODES. A prefix test over a version STRING is not a
 * version test: `'3.2.0 || 4.0.0'` and `'>=3.2.0'` are legal Helm ranges that a
 * prefix check waves through. And a build-time throw alone is not a guard when
 * `version` is a RUNTIME spec field a KRO consumer sets on the CR at apply
 * time — so the KRO path is closed by narrowing `spec.version` on the generated
 * CRD, where admission does the refusing.
 */
describe('clickstackBootstrap initialUser chart-version allowlist', () => {
  it('accepts only the exact audited versions', () => {
    expect(isClickStackInitialUserValidatedChartVersion('3.2.0')).toBe(true);
    expect(isClickStackInitialUserValidatedChartVersion(' 3.2.0 ')).toBe(true);
    expect(CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS).toEqual(['3.2.0']);
  });

  it('rejects a patch release until somebody audits it', () => {
    // Nothing about a z-bump promises the data contract is unchanged, and the
    // audit is minutes of work, so a patch is not auto-accepted.
    expect(isClickStackInitialUserValidatedChartVersion('3.2.1')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('3.2.0-rc.1')).toBe(false);
  });

  it('rejects the range expressions a prefix check would have admitted', () => {
    // The exact holes the review named. Set membership cannot be fooled by
    // them, because a range expression is never equal to a version.
    expect(isClickStackInitialUserValidatedChartVersion('3.2.0 || 4.0.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('>=3.2.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('~3.2.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('^3.2.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('3.2.x')).toBe(false);
  });

  it('rejects any other version', () => {
    expect(isClickStackInitialUserValidatedChartVersion('3.3.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('4.0.0')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('latest')).toBe(false);
    expect(isClickStackInitialUserValidatedChartVersion('')).toBe(false);
  });

  it('throws at build time for every rejected form, including the ranges', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-version-guard',
      kind: 'ClickstackVersionGuard',
    });
    const render = (version: string) =>
      bootstrap
        .factory('direct', { namespace: 'clickstack' })
        .toYaml({ ...BOOTSTRAP_SPEC_FOR_VERSION_GUARD, version } as never);

    for (const version of ['3.2.1', '3.2.0 || 4.0.0', '>=3.2.0', '3.3.0', '4.0.0']) {
      expect(() => render(version)).toThrow(/audited only against chart version/);
    }
    expect(() => render('3.2.0')).not.toThrow();
  });

  it('narrows spec.version on the generated CRD so KRO admission refuses it too', () => {
    // THE HOLE A BUILD-TIME THROW CANNOT CLOSE: `version` is a runtime spec
    // field, so a KRO consumer supplies it on the CR at apply time, where there
    // is no build to fail. The RGD therefore carries a CEL validation.
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-version-kro',
      kind: 'ClickstackVersionKro',
    });
    const yaml = bootstrap.toYaml();

    // `applySchemaFieldValidations` escapes the rule's own quotes inside the
    // KRO SimpleSchema field marker, which KRO turns into an
    // `x-kubernetes-validations` entry on the CRD.
    expect(yaml).toContain('version: string | validation="self in [\\"3.2.0\\"]"');
    // The field is optional, so a CR that omits it falls through to TypeKro's
    // own default — which is itself on the allowlist.
    expect(isClickStackInitialUserValidatedChartVersion(DEFAULT_CLICKSTACK_VERSION)).toBe(true);
  });

  it('narrows spec.version in the secretValues variants too, which had no validations at all', () => {
    const bootstrap = makeClickstackBootstrap({
      credentials: { source: 'secretValues' },
      initialUser: { email: 'ops@example.com' },
      name: 'clickstack-version-kro-secret',
      kind: 'ClickstackVersionKroSecret',
    });
    expect(bootstrap.toYaml()).toContain('version: string | validation="self in [\\"3.2.0\\"]"');
  });

  it('lets a caller who has audited a newer chart opt out of both halves', () => {
    const bootstrap = makeClickstackBootstrap({
      initialUser: { email: 'ops@example.com', allowUnvalidatedChartVersion: true },
      name: 'clickstack-version-optout',
      kind: 'ClickstackVersionOptout',
    });

    expect(() =>
      bootstrap
        .factory('direct', { namespace: 'clickstack' })
        .toYaml({ ...BOOTSTRAP_SPEC_FOR_VERSION_GUARD, version: '4.0.0' } as never)
    ).not.toThrow();
    expect(bootstrap.toYaml()).not.toContain('self in [');
  });

  it('never fires when initialUser is unconfigured', () => {
    expect(() =>
      clickstackBootstrap
        .factory('direct', { namespace: 'clickstack' })
        .toYaml({ ...BOOTSTRAP_SPEC_FOR_VERSION_GUARD, version: '9.9.9' } as never)
    ).not.toThrow();
    expect(clickstackBootstrap.toYaml()).not.toContain('self in [');
  });
});
