// HyperDX Team defaults: the ClickHouse connection and the log / trace /
// metric / session sources a Team needs before HyperDX's UI stops showing its
// "set up your connection to ClickHouse" onboarding modal.
//
// HOW HYPERDX DOES IT (read from the published hyperdx:2.35.0 image,
// /app/packages/api/build):
//
// - `setupDefaults.js` / `setupTeamDefaults(teamId)` parses the
//   `DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` env (`config.js`). It creates the
//   connections when the Team has none, then the sources when the Team has
//   none. A source's `connection` names a connection, which it resolves to that
//   connection's `_id`. A second pass writes `logSourceId` / `traceSourceId` /
//   `sessionSourceId` / `metricSourceId` as the referenced source's `_id` as a
//   hex STRING.
// - It is called from exactly two places: `routers/api/root.js`
//   (`POST /register/password`, right after `createTeam`) and `server.js` (local
//   app mode only). A Team created any other way, such as the Team this
//   composition inserts when `initialUser` is not configured, never gets
//   defaults. That is the empty Team, and the onboarding modal, this module
//   fixes.
// - `models/connection.js`: collection `connections`, fields `team`
//   (ObjectId), `name`, `host`, `username`, `password` (a PLAIN string, stored
//   as given; `select: false` only hides it from reads), timestamps. No `port`
//   field: `DEFAULT_CONNECTIONS`' `port` is dropped by Mongoose's strict mode.
//   Index `{team: 1, _id: 1}`.
// - `models/source.js`: collection `sources`, discriminated on `kind`. Base
//   fields `team`, `connection` (ObjectId), `name`, `section`, `disabled`
//   (default false), `from {databaseName, tableName}`,
//   `timestampValueExpression`, `querySettings` (array, so default []). Each
//   kind declares its own fields and strict mode drops the rest, so the session
//   source keeps only `traceSourceId` and `resourceAttributesExpression`.
//   `metricTables` is a nested schema with `_id: false`. Index
//   `{team: 1, _id: 1}`.
// - The frontend's `OnboardingModal` opens its "connection" step when
//   `GET /api/connections` returns [] and its source step when
//   `GET /api/sources` returns [].
//
// WHY THE BOOTSTRAP WRITES THE DOCUMENTS, not HyperDX's own function: it can
// only be called from inside the HyperDX API process. The OIDC plugin runs
// there, but only when OIDC is configured, and the empty Team exists in every
// deployment. Running it from a CronJob would mean a second copy of the HyperDX
// image, pinned to whatever tag the chart resolved. So the CronJob writes
// exactly what `setupTeamDefaults` writes for the same input (the real-image
// integration test compares the two field by field), and `HYPERDX_SOURCE_FIELDS`
// below records the 2.35.0 schema it mirrors.

/** Name of the HyperDX connection emitted into `defaultConnections`/`defaultSources`. */
export const CLICKSTACK_CONNECTION_NAME = 'External ClickHouse';

/**
 * The HyperDX default sources TypeKro renders into the chart's `defaultSources`
 * and seeds into an empty Team. They mirror the chart defaults (chart 3.2.0),
 * with the connection renamed and the database left as a placeholder.
 */
export const CLICKSTACK_DEFAULT_SOURCES: readonly Readonly<Record<string, unknown>>[] = [
  {
    from: { databaseName: '%s', tableName: 'otel_logs' },
    kind: 'log',
    timestampValueExpression: 'Timestamp',
    name: 'Logs',
    displayedTimestampValueExpression: 'Timestamp',
    implicitColumnExpression: 'Body',
    serviceNameExpression: 'ServiceName',
    bodyExpression: 'Body',
    eventAttributesExpression: 'LogAttributes',
    resourceAttributesExpression: 'ResourceAttributes',
    defaultTableSelectExpression: 'Timestamp,ServiceName,SeverityText,Body',
    severityTextExpression: 'SeverityText',
    traceIdExpression: 'TraceId',
    spanIdExpression: 'SpanId',
    connection: CLICKSTACK_CONNECTION_NAME,
    traceSourceId: 'Traces',
    sessionSourceId: 'Sessions',
    metricSourceId: 'Metrics',
  },
  {
    from: { databaseName: '%s', tableName: 'otel_traces' },
    kind: 'trace',
    timestampValueExpression: 'Timestamp',
    name: 'Traces',
    displayedTimestampValueExpression: 'Timestamp',
    implicitColumnExpression: 'SpanName',
    serviceNameExpression: 'ServiceName',
    bodyExpression: 'SpanName',
    eventAttributesExpression: 'SpanAttributes',
    resourceAttributesExpression: 'ResourceAttributes',
    defaultTableSelectExpression: 'Timestamp,ServiceName,StatusCode,round(Duration/1e6),SpanName',
    traceIdExpression: 'TraceId',
    spanIdExpression: 'SpanId',
    durationExpression: 'Duration',
    durationPrecision: 9,
    parentSpanIdExpression: 'ParentSpanId',
    spanNameExpression: 'SpanName',
    spanKindExpression: 'SpanKind',
    statusCodeExpression: 'StatusCode',
    statusMessageExpression: 'StatusMessage',
    connection: CLICKSTACK_CONNECTION_NAME,
    logSourceId: 'Logs',
    sessionSourceId: 'Sessions',
    metricSourceId: 'Metrics',
  },
  {
    from: { databaseName: '%s', tableName: '' },
    kind: 'metric',
    timestampValueExpression: 'TimeUnix',
    name: 'Metrics',
    resourceAttributesExpression: 'ResourceAttributes',
    metricTables: {
      gauge: 'otel_metrics_gauge',
      histogram: 'otel_metrics_histogram',
      sum: 'otel_metrics_sum',
      _id: '682586a8b1f81924e628e808',
      id: '682586a8b1f81924e628e808',
    },
    connection: CLICKSTACK_CONNECTION_NAME,
    logSourceId: 'Logs',
    traceSourceId: 'Traces',
    sessionSourceId: 'Sessions',
  },
  {
    from: { databaseName: '%s', tableName: 'hyperdx_sessions' },
    kind: 'session',
    timestampValueExpression: 'TimestampTime',
    name: 'Sessions',
    displayedTimestampValueExpression: 'Timestamp',
    implicitColumnExpression: 'Body',
    serviceNameExpression: 'ServiceName',
    bodyExpression: 'Body',
    eventAttributesExpression: 'LogAttributes',
    resourceAttributesExpression: 'ResourceAttributes',
    defaultTableSelectExpression: 'Timestamp,ServiceName,SeverityText,Body',
    severityTextExpression: 'SeverityText',
    traceIdExpression: 'TraceId',
    spanIdExpression: 'SpanId',
    connection: CLICKSTACK_CONNECTION_NAME,
    logSourceId: 'Logs',
    traceSourceId: 'Traces',
    metricSourceId: 'Metrics',
  },
];

// Environment the Team-bootstrap CronJob carries the seed connection in. The
// password is a `secretKeyRef` to the chart-owned Secret, never a value.
export const HYPERDX_DEFAULT_CONNECTION_HOST_ENV = 'HYPERDX_DEFAULT_CONNECTION_HOST';
export const HYPERDX_DEFAULT_CONNECTION_USERNAME_ENV = 'HYPERDX_DEFAULT_CONNECTION_USERNAME';
export const HYPERDX_DEFAULT_CONNECTION_PASSWORD_ENV = 'HYPERDX_DEFAULT_CONNECTION_PASSWORD';
export const HYPERDX_DEFAULT_SOURCES_DATABASE_ENV = 'HYPERDX_DEFAULT_SOURCES_DATABASE';
/** The chart version the release runs, for the seed's runtime version check. */
export const CLICKSTACK_CHART_VERSION_ENV = 'CLICKSTACK_CHART_VERSION';
/** Key of the chart-owned `clickstack-secret` holding the HyperDX UI user's ClickHouse password. */
export const CLICKSTACK_APP_PASSWORD_SECRET_KEY = 'CLICKHOUSE_APP_PASSWORD';

// The Mongoose schema of HyperDX 2.35.0's sources (models/source.js), per kind:
// the fields strict mode keeps. Anything else in a source definition is dropped
// on write by HyperDX, so the seed drops it too.
const SOURCE_BASE_FIELDS = [
  'name',
  'kind',
  'section',
  'disabled',
  'from',
  'timestampValueExpression',
  'querySettings',
] as const;
const SEARCHABLE_SOURCE_FIELDS = [
  'defaultTableSelectExpression',
  'serviceNameExpression',
  'serviceVersionExpression',
  'resourceAttributesExpression',
  'eventAttributesExpression',
  'displayedTimestampValueExpression',
  'traceIdExpression',
  'spanIdExpression',
  'implicitColumnExpression',
  'knownColumnsListExpression',
  'useTextIndexForImplicitColumn',
  'highlightedTraceAttributeExpressions',
  'highlightedRowAttributeExpressions',
  'materializedViews',
  'metadataMaterializedViews',
  'orderByExpression',
  'metricSourceId',
] as const;
const HYPERDX_SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  log: [
    ...SEARCHABLE_SOURCE_FIELDS,
    'severityTextExpression',
    'bodyExpression',
    'traceSourceId',
    'tableFilterExpression',
  ],
  trace: [
    ...SEARCHABLE_SOURCE_FIELDS,
    'durationExpression',
    'durationPrecision',
    'parentSpanIdExpression',
    'spanNameExpression',
    'spanKindExpression',
    'sampleRateExpression',
    'logSourceId',
    'sessionSourceId',
    'statusCodeExpression',
    'statusMessageExpression',
    'spanEventsValueExpression',
    'spanLinksValueExpression',
  ],
  session: ['traceSourceId', 'resourceAttributesExpression'],
  metric: [
    'metricTables',
    'resourceAttributesExpression',
    'serviceNameExpression',
    'logSourceId',
    'seriesTable',
  ],
};
// Untyped `Schema.Types.Array` paths: Mongoose defaults them to [] on create.
const ARRAY_DEFAULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  log: [
    'highlightedTraceAttributeExpressions',
    'highlightedRowAttributeExpressions',
    'materializedViews',
  ],
  trace: [
    'highlightedTraceAttributeExpressions',
    'highlightedRowAttributeExpressions',
    'materializedViews',
  ],
};
// `MetricTablesSchema` (`_id: false`): the `MetricsDataType` keys only.
const METRIC_TABLE_KEYS = [
  'gauge',
  'histogram',
  'sum',
  'summary',
  'exponential histogram',
] as const;
const SOURCE_REFERENCE_FIELDS = [
  'logSourceId',
  'traceSourceId',
  'sessionSourceId',
  'metricSourceId',
] as const;

/** One source as the bootstrap seeds it: the document, minus ids, and its references by name. */
export interface HyperdxSeedSource {
  name: string;
  /** Fields as HyperDX 2.35.0 stores them, without `_id`/`team`/`connection`/timestamps. */
  document: Record<string, unknown>;
  /** Reference field → name of the referenced source. */
  references: Record<string, string>;
}

/**
 * Turn source definitions (the `DEFAULT_SOURCES` shape) into the documents
 * HyperDX 2.35.0's `setupTeamDefaults` would store for them.
 *
 * @throws Error for a source kind this schema mirror does not know
 */
export function renderHyperdxSeedSources(
  sources: readonly Readonly<Record<string, unknown>>[] = CLICKSTACK_DEFAULT_SOURCES
): HyperdxSeedSource[] {
  const names = new Set(sources.map((source) => String(source.name)));
  return sources.map((source) => {
    const kind = String(source.kind);
    const kindFields = HYPERDX_SOURCE_FIELDS[kind];
    if (kindFields === undefined) {
      throw new Error(`HyperDX source kind ${JSON.stringify(kind)} is not one TypeKro can seed`);
    }
    const document: Record<string, unknown> = { disabled: false, querySettings: [] };
    for (const field of ARRAY_DEFAULT_FIELDS[kind] ?? []) document[field] = [];
    const references: Record<string, string> = {};
    for (const [field, value] of Object.entries(source)) {
      if ((SOURCE_REFERENCE_FIELDS as readonly string[]).includes(field)) {
        // setupTeamDefaults' second pass: only a field the kind declares, and
        // only to a source created in the same run.
        if (kindFields.includes(field) && names.has(String(value)))
          references[field] = String(value);
        continue;
      }
      if (field === 'from') {
        const from = value as { databaseName?: unknown; tableName?: unknown };
        document.from = { databaseName: from.databaseName, tableName: from.tableName };
      } else if (field === 'metricTables') {
        const tables = value as Record<string, unknown>;
        document.metricTables = Object.fromEntries(
          METRIC_TABLE_KEYS.filter((key) => tables[key] !== undefined).map((key) => [
            key,
            tables[key],
          ])
        );
      } else if (
        (SOURCE_BASE_FIELDS as readonly string[]).includes(field) ||
        kindFields.includes(field)
      ) {
        document[field] = value;
      }
    }
    return { name: String(source.name), document, references };
  });
}

/** Marker `_id` prefixes in the TypeKro-owned bootstrap collection. */
const TEAM_DEFAULTS_MARKER_PREFIX = 'team-defaults:';
const TEAM_NAME_MARKER_PREFIX = 'team-name:';
/**
 * HyperDX seeds a Team it creates within the request that creates it. A Team
 * TypeKro did not create is left alone for this long before TypeKro concludes
 * HyperDX did not seed it, so the two never write at the same time.
 */
export const CLICKSTACK_TEAM_DEFAULTS_GRACE_SECONDS = 60;

/**
 * SHA-256 of the one Team name earlier releases hard-coded into the degraded
 * script, which never renamed a Team afterwards. A Team TypeKro has no name
 * record for is therefore renamed only when it still carries THAT name: any
 * other name was set by a human. Kept as a hash so the old name itself does not
 * reappear in the source.
 */
export const CLICKSTACK_LEGACY_TEAM_NAME_SHA256 =
  'ab4a37c600c179cb4094b35819aa5cd4eedb50ee36ff0ddbbf2bccb3061a767d';

/**
 * Which name counts as "never renamed by a human" on a Team TypeKro has no
 * name record for, and so may be renamed to `teamName`.
 */
export interface UntouchedTeamName {
  /** A default matched by SHA-256, e.g. the legacy name (needs `require('crypto')`). */
  sha256: readonly string[];
  /** A default matched as-is, e.g. HyperDX's registration name `<email>'s Team`. */
  exact?: string;
}

/** Options for {@link renderTeamBootstrapHelpers}. */
export interface TeamBootstrapHelperOptions {
  /** `false` renders a `seedTeamDefaults` that does nothing. */
  seed: boolean;
  /**
   * The chart versions the seed may write on, checked at RUNTIME against
   * {@link CLICKSTACK_CHART_VERSION_ENV}; `undefined` skips the check (the
   * `allowUnvalidatedChartVersion` escape hatch). The build-time guard and
   * the CRD rule cover the same ground, but KRO 0.9.2 does not add a
   * validation rule to a CRD it already created, so this is what holds on an
   * upgraded KRO deployment.
   */
  validatedChartVersions?: readonly string[];
  untouchedName: UntouchedTeamName;
}

/**
 * The mongosh helpers both Team-bootstrap scripts share: `reconcileTeamName`
 * and `seedTeamDefaults`. Expects `database` (the HyperDX db) and
 * `bootstrapMarkers` (the TypeKro-owned collection) in scope.
 *
 * - `recordTeamName(teamId, name)` records that TypeKro set (and owns) the
 *   name; the degraded path calls it BEFORE inserting a Team it creates.
 * - `reconcileTeamName(team, name)` renames the Team only while TypeKro owns
 *   its name: the recorded name, or, with no record, the untouched default.
 *   Anything else is recorded as a person's name (`null`), and stays theirs.
 *   The update is conditional on the name it read, so a concurrent rename in
 *   the UI wins.
 * - `seedTeamDefaults(team, createdByTypekro)` seeds the connection and the
 *   sources ONCE per Team, and only into a Team that has neither.
 */
export function renderTeamBootstrapHelpers(options: TeamBootstrapHelperOptions): string[] {
  const { exact, sha256 } = options.untouchedName;
  const untouched = `const isUntouchedTeamName = (name) => typeof name === 'string' && (${
    exact === undefined ? '' : `name === ${JSON.stringify(exact)} || `
  }${JSON.stringify(sha256)}.indexOf(require('crypto').createHash('sha256').update(name).digest('hex')) !== -1);`;
  const nameHelper = [
    untouched,
    `const teamNameMarkerId = (teamId) => ${JSON.stringify(TEAM_NAME_MARKER_PREFIX)} + String(teamId);`,
    // `appliedName` is the name TypeKro set and still owns; `null` means a
    // person owns the name, for good.
    'const recordTeamName = (teamId, appliedName) => bootstrapMarkers.updateOne({ _id: teamNameMarkerId(teamId) }, { $set: { appliedName, appliedAt: new Date() } }, { upsert: true });',
    'const reconcileTeamName = (team, desiredName) => {',
    '  const marker = bootstrapMarkers.findOne({ _id: teamNameMarkerId(team._id) });',
    '  if (marker !== null && marker.appliedName === null) return;',
    '  if (marker === null) {',
    // No record: TypeKro owns the name only if it is still the default the
    // Team was created with. Anything else, even today's `teamName`, is a
    // person's choice.
    '    if (!isUntouchedTeamName(team.name)) {',
    '      recordTeamName(team._id, null);',
    "      print('ClickStack team name: the Team is named ' + JSON.stringify(team.name) + ' by someone else, so TypeKro leaves it.');",
    '      return;',
    '    }',
    '  } else if (marker.appliedName !== team.name) {',
    '    recordTeamName(team._id, null);',
    "    print('ClickStack team name: the Team was renamed to ' + JSON.stringify(team.name) + ' in HyperDX, so TypeKro leaves it from now on.');",
    '    return;',
    '  }',
    '  if (team.name === desiredName) {',
    '    if (marker === null) recordTeamName(team._id, desiredName);',
    '    return;',
    '  }',
    // Only the name changes: `_id`, the apiKey and the users' `team` refs stay.
    // Filtered on the name read above: a rename in the UI since then wins, and
    // the next run records it as a person's.
    '  const result = database.teams.updateOne({ _id: team._id, name: team.name }, { $set: { name: desiredName, updatedAt: new Date() } });',
    '  if (result.matchedCount !== 1) {',
    "    print('ClickStack team name: the Team was renamed while TypeKro was renaming it, so TypeKro leaves it.');",
    '    return;',
    '  }',
    '  recordTeamName(team._id, desiredName);',
    "  print('ClickStack team name: renamed the Team from ' + JSON.stringify(team.name) + ' to ' + JSON.stringify(desiredName) + '.');",
    '};',
  ];
  if (!options.seed) return [...nameHelper, 'const seedTeamDefaults = () => {};'];

  const seedSources = renderHyperdxSeedSources();
  return [
    ...nameHelper,
    `const seedConnectionName = ${JSON.stringify(CLICKSTACK_CONNECTION_NAME)};`,
    `const seedSources = ${JSON.stringify(seedSources)};`,
    // Insert by a RESERVED `_id`: a retried run fills in what an interrupted
    // one did not, and never writes a document twice or over an existing one.
    'const insertIfAbsent = (collection, document, what) => {',
    '  try {',
    '    collection.insertOne(document);',
    '  } catch (error) {',
    // Re-thrown WITHOUT the error's own text: it could echo the document, and
    // the connection document carries the password.
    "    if (error.code !== 11000) throw new Error('ClickStack team defaults: inserting the ' + what + ' failed (' + (error.codeName || error.code || error.name) + ').');",
    '  }',
    '};',
    'const seedTeamDefaults = (team, createdByTypekro) => {',
    `  const markerId = ${JSON.stringify(TEAM_DEFAULTS_MARKER_PREFIX)} + String(team._id);`,
    '  let marker = bootstrapMarkers.findOne({ _id: markerId });',
    "  if (marker !== null && marker.state === 'complete') return;",
    ...(options.validatedChartVersions === undefined
      ? []
      : [
          `  const chartVersion = process.env.${CLICKSTACK_CHART_VERSION_ENV};`,
          `  if (${JSON.stringify(options.validatedChartVersions)}.indexOf(chartVersion) === -1) {`,
          `    print('ClickStack team defaults: chart version ' + JSON.stringify(chartVersion) + ' is not one TypeKro has audited HyperDX\\'s connections/sources schema on (${options.validatedChartVersions.join(', ')}), so TypeKro seeds nothing. Set teamDefaults: { allowUnvalidatedChartVersion: true } once you have checked it.');`,
          '    return;',
          '  }',
        ]),
    `  const host = process.env.${HYPERDX_DEFAULT_CONNECTION_HOST_ENV};`,
    `  const username = process.env.${HYPERDX_DEFAULT_CONNECTION_USERNAME_ENV};`,
    `  const sourceDatabase = process.env.${HYPERDX_DEFAULT_SOURCES_DATABASE_ENV};`,
    `  const password = process.env.${HYPERDX_DEFAULT_CONNECTION_PASSWORD_ENV};`,
    `  if (typeof host !== 'string' || host.length === 0 || typeof username !== 'string' || typeof sourceDatabase !== 'string') throw new Error('${HYPERDX_DEFAULT_CONNECTION_HOST_ENV}, ${HYPERDX_DEFAULT_CONNECTION_USERNAME_ENV} and ${HYPERDX_DEFAULT_SOURCES_DATABASE_ENV} are required to seed the HyperDX Team defaults.');`,
    // The Secret key is referenced `optional: true`, so a MISSING key arrives
    // as an unset variable: seed nothing and say why, with no marker, so the
    // seed happens once the key exists. A key that exists but is EMPTY is a
    // passwordless ClickHouse user and is seeded as '', as HyperDX does.
    "  if (typeof password !== 'string') {",
    `    print('ClickStack team defaults: the ClickHouse password Secret key is missing, so TypeKro seeds nothing until it exists (${HYPERDX_DEFAULT_CONNECTION_PASSWORD_ENV} is unset).');`,
    '    return;',
    '  }',
    '  if (marker === null) {',
    `    if (!createdByTypekro && team.createdAt instanceof Date && Date.now() - team.createdAt.getTime() < ${CLICKSTACK_TEAM_DEFAULTS_GRACE_SECONDS * 1000}) {`,
    "      print('ClickStack team defaults: the Team is new and HyperDX may still be setting it up; checking again next run.');",
    '      return;',
    '    }',
    // Anything already there is someone else's configuration: never touch it.
    '    if (database.connections.countDocuments({ team: team._id }, { limit: 1 }) > 0 || database.sources.countDocuments({ team: team._id }, { limit: 1 }) > 0) {',
    "      bootstrapMarkers.updateOne({ _id: markerId }, { $setOnInsert: { state: 'complete', seeded: false, completedAt: new Date() } }, { upsert: true });",
    "      print('ClickStack team defaults: the Team already has a connection or a source, so TypeKro seeds nothing.');",
    '      return;',
    '    }',
    '    const sourceIds = {};',
    '    for (const source of seedSources) sourceIds[source.name] = new ObjectId();',
    "    insertIfAbsent(bootstrapMarkers, { _id: markerId, state: 'seeding', connectionId: new ObjectId(), sourceIds, inserted: {}, startedAt: new Date() }, 'seed plan');",
    '    marker = bootstrapMarkers.findOne({ _id: markerId });',
    "    if (marker.state === 'complete') return;",
    '  }',
    // Once per run, just before this run's writes (so also when a run resumes
    // an interrupted seed): a connection or source that is not one of ours
    // means someone else is configuring the Team, so stop and keep what exists.
    // One added during this run's own writes is caught by the next run only
    // if the seed is still incomplete; a completed seed leaves it untouched.
    '  const planned = [String(marker.connectionId)].concat(Object.keys(marker.sourceIds).map((name) => String(marker.sourceIds[name])));',
    '  const foreign = database.connections.find({ team: team._id }).toArray().concat(database.sources.find({ team: team._id }).toArray()).filter((document) => planned.indexOf(String(document._id)) === -1);',
    '  if (foreign.length > 0) {',
    "    bootstrapMarkers.updateOne({ _id: markerId }, { $set: { state: 'complete', seeded: false, stoppedBecause: 'foreign-configuration', completedAt: new Date() } });",
    "    print('ClickStack team defaults: someone else added a connection or a source while TypeKro was seeding, so TypeKro stops and keeps what exists.');",
    '    return;',
    '  }',
    // Each document is recorded once inserted, so a resume never re-creates a
    // planned document that a user deleted after it was written.
    '  const inserted = marker.inserted || {};',
    '  const insertPlanned = (key, collection, document, what) => {',
    '    if (inserted[key] === true) return;',
    '    insertIfAbsent(collection, document, what);',
    "    bootstrapMarkers.updateOne({ _id: markerId }, { $set: { ['inserted.' + key]: true } });",
    '  };',
    '  const now = new Date();',
    // Exactly what `createConnection` stores for a DEFAULT_CONNECTIONS entry:
    // no `port` (not in the schema), the password as given.
    "  insertPlanned('connection', database.connections, { _id: marker.connectionId, team: team._id, name: seedConnectionName, host, username, password, createdAt: now, updatedAt: now, __v: 0 }, 'connection');",
    '  for (const source of seedSources) {',
    '    const document = Object.assign({}, source.document, { _id: marker.sourceIds[source.name], team: team._id, connection: marker.connectionId, from: { databaseName: sourceDatabase, tableName: source.document.from.tableName }, createdAt: now, updatedAt: now, __v: 0 });',
    '    for (const field of Object.keys(source.references)) document[field] = String(marker.sourceIds[source.references[field]]);',
    "    insertPlanned('source:' + source.name, database.sources, document, 'source ' + JSON.stringify(source.name));",
    '  }',
    "  bootstrapMarkers.updateOne({ _id: markerId }, { $set: { state: 'complete', seeded: true, completedAt: new Date() } });",
    "  print('ClickStack team defaults: seeded the ' + JSON.stringify(seedConnectionName) + ' connection and ' + seedSources.length + ' sources.');",
    '};',
  ];
}
