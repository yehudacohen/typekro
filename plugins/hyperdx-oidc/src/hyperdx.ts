/**
 * Wiring into a running HyperDX API process.
 *
 * HyperDX authenticates with Passport and keeps sessions in MongoDB through
 * express-session. The plugin joins that same path rather than working around
 * it: it registers one Passport strategy per provider on HyperDX's own
 * `passport` instance, adds routes to HyperDX's own root router, and ends every
 * successful login in `req.logIn()`. The result is an ordinary HyperDX session,
 * so every route, logout and the rest of the app work unchanged.
 *
 * Everything HyperDX-specific is resolved here, from the API's own build
 * directory, and checked before anything is changed. If a hook point is
 * missing (a HyperDX version this plugin was not built for), the plugin logs
 * why and does nothing — password login keeps working.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type BootstrapCredentials, isBootstrapRegistration, normalizeRoutePath } from './bootstrap.js';
import { type OidcPluginConfig, parseOidcPluginConfig } from './config.js';
import { evaluateClaims, type IdentityStore, LinkConflictError, resolveAccount, type VerifiedIdentity } from './identity.js';
import { OidcFlowError, type PendingLogin, ProviderRuntime, safeReturnTo } from './oidc.js';
import { renderChooser, renderDenied } from './pages.js';

// ── Minimal structural types for the parts of HyperDX and Express we touch ──

interface Session {
  typekroOidcPending?: PendingLogin;
  typekroOidcAuth?: { provider: string; at: number };
  messages?: string[];
}

interface Request {
  method: string;
  path: string;
  originalUrl: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  /** Parsed by HyperDX's app-level express.json/urlencoded, before the root router. */
  body?: unknown;
  session?: Session;
  user?: unknown;
  logIn(user: unknown, done: (error?: unknown) => void): void;
  logout(done: (error?: unknown) => void): void;
}

interface Response {
  status(code: number): Response;
  type(value: string): Response;
  send(body: string): void;
  redirect(status: number, url: string): void;
}

type Next = (error?: unknown) => void;
type Handler = (req: Request, res: Response, next: Next) => void;

interface Router {
  stack: unknown[];
  get(path: string, handler: Handler): void;
  use(handler: Handler): void;
}

interface StrategyContext {
  success(user: unknown, info?: unknown): void;
  fail(info?: unknown, status?: number): void;
  redirect(url: string): void;
  error(error: unknown): void;
}

interface Strategy {
  name?: string;
  authenticate(this: StrategyContext, req: Request, options?: unknown): void;
}

interface Passport {
  use(name: string, strategy: Strategy & { name: string }): void;
  unuse(name: string): void;
  authenticate(name: string, callback: (error: unknown, user: unknown, info: unknown) => void): Handler;
  _strategy(name: string): Strategy | undefined;
}

interface MongooseModel {
  findOne(filter: Record<string, unknown>): { select(fields: string): { lean(): Promise<unknown> } };
  find(filter: Record<string, unknown>): { select(fields: string): { limit(n: number): { lean(): Promise<unknown[]> } } };
  findById(id: string): Promise<unknown>;
  create(doc: Record<string, unknown>): Promise<{ _id: { toString(): string } }>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  db: { collection(name: string): Collection };
}

interface Collection {
  createIndex(spec: Record<string, number>, options: Record<string, unknown>): Promise<unknown>;
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
}

interface Hyperdx {
  passport: Passport;
  rootRouter: Router;
  User: MongooseModel;
  Team: MongooseModel;
  createTeam(input: { name: string; collectorAuthenticationEnforced?: boolean }): Promise<{ _id: { toString(): string } }>;
  setupTeamDefaults(teamId: string): Promise<unknown>;
  frontendUrl: string;
  frontendRedirectBase: string;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const STRATEGY_PREFIX = 'typekro-oidc:';
const IDENTITY_COLLECTION = 'typekro_oidc_identities';
/** Plugin-owned coordination documents (the team-claim lock). */
const STATE_COLLECTION = 'typekro_oidc_state';
const TEAM_CLAIM_ID = 'team-claim';
/** How long a first login waits for another login's team creation. */
const TEAM_CLAIM_WAIT_MS = 15_000;
/** A claim older than this with still no team is from a crashed process and may be taken over. */
const TEAM_CLAIM_STALE_MS = 60_000;

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 11000;
}

/** A request path as Express matches it: case-insensitive, trailing slashes ignored. */
function normalizedPath(req: Request): string {
  return normalizeRoutePath(req.path);
}
const PASSWORD_NOT_ALLOWED = 'Authentication method password is not allowed by your team admin.';

// ── Resolution and self-check ─────────────────────────────────────────────

function defaultExport<T>(module: unknown): T {
  const record = module as { default?: T };
  return (record.default ?? module) as T;
}

/**
 * Resolve every HyperDX internal the plugin depends on, from the API's build
 * directory, so the plugin shares HyperDX's module instances (the same
 * `passport`, the same Mongoose connection). Throws naming the first missing
 * hook point.
 */
export function resolveHyperdx(apiBuildDir: string): Hyperdx {
  const requireFromApi = createRequire(join(apiBuildDir, 'index.js'));
  const load = (specifier: string) => requireFromApi(specifier) as Record<string, unknown>;

  const passport = defaultExport<Passport>(load('passport'));
  const rootRouter = defaultExport<Router>(load('./routers/api/root.js'));
  const User = defaultExport<MongooseModel>(load('./models/user.js'));
  const Team = defaultExport<MongooseModel>(load('./models/team.js'));
  const teamController = load('./controllers/team.js');
  const setupDefaults = load('./setupDefaults.js');
  const config = load('./config.js');

  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['passport.use', typeof passport?.use === 'function'],
    ['passport.unuse', typeof passport?.unuse === 'function'],
    ['passport.authenticate', typeof passport?.authenticate === 'function'],
    ["passport._strategy('local')", typeof passport?._strategy === 'function' && typeof passport._strategy('local')?.authenticate === 'function'],
    ['routers/api/root router', Array.isArray(rootRouter?.stack) && typeof rootRouter?.get === 'function'],
    ['models/user', typeof User?.findOne === 'function' && typeof User?.create === 'function' && typeof User?.updateOne === 'function'],
    ['models/team', typeof Team?.find === 'function'],
    ['controllers/team.createTeam', typeof teamController.createTeam === 'function'],
    ['setupDefaults.setupTeamDefaults', typeof setupDefaults.setupTeamDefaults === 'function'],
    ['config.FRONTEND_URL', typeof config.FRONTEND_URL === 'string' || config.FRONTEND_URL === undefined],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`HyperDX hook point(s) not found: ${missing.join(', ')}`);
  }

  return {
    passport,
    rootRouter,
    User,
    Team,
    createTeam: teamController.createTeam as Hyperdx['createTeam'],
    setupTeamDefaults: setupDefaults.setupTeamDefaults as Hyperdx['setupTeamDefaults'],
    frontendUrl: String(config.FRONTEND_URL ?? '').replace(/\/+$/, ''),
    frontendRedirectBase: String(config.FRONTEND_REDIRECT_BASE ?? config.FRONTEND_URL ?? '').replace(/\/+$/, ''),
  };
}

// ── Accounts in HyperDX's MongoDB ─────────────────────────────────────────

function mongoIdentityStore(
  hyperdx: Hyperdx,
  config: () => OidcPluginConfig,
  options: PluginOptions,
  log: Logger
): IdentityStore {
  const links = hyperdx.User.db.collection(IDENTITY_COLLECTION);
  const state = hyperdx.User.db.collection(STATE_COLLECTION);

  // Both link invariants are enforced by UNIQUE indexes, not by the
  // check-then-write in resolveAccount: one link per (provider, subject), and
  // one link per HyperDX user — so two subjects racing to link the same
  // account by email cannot both win. Linking waits for the indexes and fails
  // CLOSED if they cannot be created; a failed attempt is retried next login.
  let indexes: Promise<void> | undefined;
  const ensureIndexes = (): Promise<void> => {
    if (indexes === undefined) {
      indexes = Promise.all([
        links.createIndex({ provider: 1, subject: 1 }, { unique: true, name: 'provider_subject' }),
        links.createIndex({ userId: 1 }, { unique: true, name: 'user' }),
      ]).then(
        () => undefined,
        (error: unknown) => {
          indexes = undefined;
          log.error('could not create the identity-link indexes; OIDC sign-in is refused until they exist', {
            error: String(error),
          });
          throw new OidcFlowError('storeUnavailable', 'identity-link indexes are not in place');
        }
      );
    }
    return indexes;
  };
  // Start creating them now; a failure is already logged, and retried by the next login.
  ensureIndexes().catch(() => {
    /* logged in ensureIndexes */
  });

  async function newUserTeamId(email: string): Promise<string> {
    const configured = config().teamId;
    if (configured !== undefined) {
      const team = await hyperdx.Team.findById(configured);
      if (team === null) throw new Error(`configured teamId ${configured} does not exist`);
      return configured;
    }
    const findTeams = async () =>
      (await hyperdx.Team.find({}).select('_id').limit(2).lean()) as Array<{ _id: { toString(): string } }>;
    const teams = await findTeams();
    if (teams.length === 1) return (teams[0] as { _id: { toString(): string } })._id.toString();
    if (teams.length > 1) throw new Error('more than one HyperDX team exists; set teamId in the OIDC configuration');
    if (!options.createTeam) {
      // Something else claims the instance (TypeKro's initialUser bootstrap);
      // creating the team here would take the break-glass account's place.
      throw new OidcFlowError('instanceNotReady', 'no HyperDX team exists yet and this plugin does not create one');
    }
    // No team yet: this login claims the instance, exactly as HyperDX's own
    // first registration does (create the team, then its default sources).
    //
    // HyperDX's own check-then-create is not atomic, so concurrent first
    // logins — across replicas too — would each create a team. They race for
    // a claim document with a unique _id instead: exactly one wins and
    // creates the team; the rest wait for it and never create one.
    const onlyTeam = (teams: Array<{ _id: { toString(): string } }>) =>
      teams.length === 1 ? (teams[0] as { _id: { toString(): string } })._id.toString() : undefined;
    try {
      await state.insertOne({ _id: TEAM_CLAIM_ID, at: new Date(), by: email });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const deadline = Date.now() + TEAM_CLAIM_WAIT_MS;
      while (Date.now() < deadline) {
        const claimed = onlyTeam(await findTeams());
        if (claimed !== undefined) return claimed;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const claim = await state.findOne({ _id: TEAM_CLAIM_ID });
      const claimedAt = claim?.at instanceof Date ? claim.at.getTime() : 0;
      if (Date.now() - claimedAt > TEAM_CLAIM_STALE_MS) {
        // The claimant died before creating the team; release the claim so
        // the next attempt can take it.
        await state.deleteOne({ _id: TEAM_CLAIM_ID, at: claim?.at });
      }
      throw new OidcFlowError('instanceNotReady', 'another first login is creating the HyperDX team');
    }
    let team: { _id: { toString(): string } };
    try {
      team = await hyperdx.createTeam({ name: `${email}'s Team`, collectorAuthenticationEnforced: true });
    } catch (error) {
      // HyperDX's own registration got there first: use its team.
      const raced = onlyTeam(await findTeams());
      if (raced !== undefined) return raced;
      await state.deleteOne({ _id: TEAM_CLAIM_ID });
      throw error;
    }
    const teamId = team._id.toString();
    await hyperdx.setupTeamDefaults(teamId).catch((error: unknown) =>
      log.error('setting up default connections and sources for the new team failed', { error: String(error) })
    );
    return teamId;
  }

  return {
    async findLinkedUserId(provider, subject) {
      await ensureIndexes();
      const link = await links.findOne({ provider, subject });
      return link === null ? null : String(link.userId);
    },
    async userExists(userId) {
      return (await hyperdx.User.findById(userId)) !== null;
    },
    async findUserIdByEmail(email) {
      const user = (await hyperdx.User.findOne({ email }).select('_id').lean()) as { _id: unknown } | null;
      return user === null ? null : String(user._id);
    },
    async userHasAnyLink(userId) {
      return (await links.findOne({ userId })) !== null;
    },
    async createUser(email, name) {
      const team = await newUserTeamId(email);
      try {
        const user = await hyperdx.User.create({ email, name, team });
        return user._id.toString();
      } catch (error) {
        // Another first login created a user with this email meanwhile.
        if (isDuplicateKeyError(error)) throw new LinkConflictError();
        throw error;
      }
    },
    async link(identity: VerifiedIdentity, userId) {
      await ensureIndexes();
      const now = new Date();
      try {
        await links.updateOne(
          { provider: identity.provider, subject: identity.subject },
          { $set: { userId, email: identity.email, lastLoginAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true }
        );
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // Either this subject's own concurrent login linked it first (fine if
        // to the same user), or another subject holds this user (conflict).
        const winner = await links.findOne({ provider: identity.provider, subject: identity.subject });
        if (winner !== null && String(winner.userId) === userId) return;
        throw new LinkConflictError();
      }
    },
    async unlink(provider, subject) {
      await links.deleteOne({ provider, subject });
    },
    async touch(provider, subject) {
      await links.updateOne({ provider, subject }, { $set: { lastLoginAt: new Date() } });
    },
  };
}

// ── The plugin ────────────────────────────────────────────────────────────

/** Deployment-level options, set by the wiring rather than the configuration document. */
export interface PluginOptions {
  /**
   * Whether a first login on an instance with no team may create it. TypeKro
   * turns this off when its `initialUser` bootstrap claims the instance.
   */
  readonly createTeam: boolean;
  /**
   * The initial user's credentials. With `createTeam` off, HyperDX's first-run
   * registration is exempt from `passwordLogin: false` only for a request
   * carrying exactly these; absent, the exemption is off.
   */
  readonly bootstrap?: BootstrapCredentials;
}

export interface InstalledPlugin {
  /** Re-read the configuration file; returns whether it was (re)applied. */
  reload(): boolean;
  /** Current provider ids. */
  providerIds(): readonly string[];
}

/**
 * Install the plugin into a resolved HyperDX: register routes and the session
 * guard, then load the configuration and bind one strategy per provider.
 */
export function installPlugin(
  hyperdx: Hyperdx,
  configPath: string,
  log: Logger,
  options: PluginOptions = { createTeam: true }
): InstalledPlugin {
  let config: OidcPluginConfig | undefined;
  let lastText: string | undefined;
  let readFailing = false;
  let providers = new Map<string, ProviderRuntime>();
  const store = mongoIdentityStore(
    hyperdx,
    () => config ?? parseOidcPluginConfig('{"providers":[]}'),
    options,
    log
  );

  /**
   * Revoke API access (external API v2, MCP) for a linked user whom the
   * provider no longer admits. Sessions end through the session guard;
   * the long-lived access key would otherwise keep working.
   */
  async function revokeAccessKeyOfLinkedSubject(provider: string, subject: unknown) {
    if (typeof subject !== 'string') return;
    const userId = await store.findLinkedUserId(provider, subject);
    if (userId === null) return;
    await hyperdx.User.updateOne({ _id: userId }, { $set: { accessKey: randomUUID() } });
    log.warn('rotated the access key of a linked user the provider no longer admits', { provider, userId });
  }

  const apiPrefix = () => config?.apiPathPrefix ?? '/api';
  const baseUrl = () => config?.redirectBaseUrl ?? hyperdx.frontendUrl;
  const loginPath = () => `${apiPrefix()}/login/oidc`;
  const frontend = (path: string) => `${hyperdx.frontendRedirectBase}${path}`;

  function strategyFor(id: string) {
    return {
      name: `${STRATEGY_PREFIX}${id}`,
      authenticate(this: StrategyContext, req: Request) {
        const provider = providers.get(id);
        if (provider === undefined) {
          this.fail({ reason: 'unknownProvider' }, 404);
          return;
        }
        const run = async () => {
          const session = req.session;
          if (session === undefined) throw new Error('HyperDX session middleware is not active');
          if (req.query.code === undefined && req.query.error === undefined) {
            const { url, pending } = await provider.begin(safeReturnTo(req.query.returnTo));
            session.typekroOidcPending = pending;
            this.redirect(url);
            return;
          }
          const pending = session.typekroOidcPending;
          delete session.typekroOidcPending;
          if (pending === undefined) {
            this.fail({ reason: 'loginExpired' }, 400);
            return;
          }
          const claims = await provider.complete(new URL(req.originalUrl, baseUrl()), pending);
          const decision = evaluateClaims(provider.config, claims);
          if (!decision.allowed) {
            log.warn('OIDC login denied', { provider: id, reason: decision.reason });
            if (decision.reason !== 'subjectMissing') {
              // Keyed on this provider's validated `sub`: only the user linked to
              // exactly that subject is affected.
              await revokeAccessKeyOfLinkedSubject(id, claims.sub);
            }
            this.fail({ reason: decision.reason, returnTo: pending.returnTo }, 403);
            return;
          }
          const account = await resolveAccount(store, provider.config, decision.identity);
          if ('denied' in account) {
            log.warn('OIDC login denied', { provider: id, reason: account.denied, email: decision.identity.email });
            this.fail({ reason: account.denied }, 403);
            return;
          }
          const user = await hyperdx.User.findById(account.userId);
          log.info('OIDC login', { provider: id, email: decision.identity.email, outcome: account.outcome });
          this.success(user, { provider: id, returnTo: pending.returnTo });
        };
        run().catch((error: unknown) => {
          if (error instanceof OidcFlowError) {
            log.warn('OIDC login failed', { provider: id, reason: error.reason, detail: error.message });
            const unavailable = ['providerUnavailable', 'instanceNotReady', 'storeUnavailable'].includes(error.reason);
            this.fail({ reason: error.reason }, unavailable ? 503 : 400);
            return;
          }
          this.error(error);
        });
      },
    };
  }

  function apply(next: OidcPluginConfig) {
    const nextProviders = new Map<string, ProviderRuntime>();
    const callbackBase = next.redirectBaseUrl ?? hyperdx.frontendUrl;
    for (const provider of next.providers) {
      const redirectUri = `${callbackBase}${next.apiPathPrefix}/login/oidc/${provider.id}/callback`;
      const existing = providers.get(provider.id);
      // Keep discovered metadata when nothing that affects it changed.
      nextProviders.set(
        provider.id,
        existing !== undefined &&
          existing.redirectUri === redirectUri &&
          JSON.stringify(existing.config) === JSON.stringify(provider)
          ? existing
          : new ProviderRuntime(provider, redirectUri, next.allowInsecureHttp)
      );
    }
    for (const id of providers.keys()) {
      if (!nextProviders.has(id)) hyperdx.passport.unuse(`${STRATEGY_PREFIX}${id}`);
    }
    for (const id of nextProviders.keys()) hyperdx.passport.use(`${STRATEGY_PREFIX}${id}`, strategyFor(id));
    providers = nextProviders;
    config = next;
    if (next.allowInsecureHttp) {
      log.warn('allowInsecureHttp is on: issuers and callbacks may use plain http. Use this only for tests; it removes the TLS protection the ID-token checks rely on.');
    }
    // Warm discovery in the background so the first login does not pay for it.
    for (const provider of providers.values()) {
      provider.authorizationServer().catch((error: unknown) =>
        log.warn('OIDC discovery failed; will retry on demand', { provider: provider.config.id, error: String(error) })
      );
    }
  }

  function reload(): boolean {
    let text: string;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch (error) {
      if (!readFailing) {
        readFailing = true;
        log.error(
          config === undefined
            ? 'OIDC configuration unreadable; no providers active'
            : 'OIDC configuration became unreadable; keeping the previous one',
          { path: configPath, error: String(error) }
        );
      }
      return false;
    }
    if (readFailing) {
      readFailing = false;
      log.info('OIDC configuration readable again', { path: configPath });
    }
    if (text === lastText) return false;
    lastText = text;
    try {
      apply(parseOidcPluginConfig(text));
    } catch (error) {
      // Keep serving the last good configuration. With none since start, the
      // password-login policy is at its default (allowed): that is the
      // break-glass path when the OIDC configuration itself is broken.
      log.error(
        config === undefined
          ? 'OIDC configuration rejected and none has been applied since start; no providers active and password login is allowed'
          : 'OIDC configuration rejected; keeping the previous one',
        { error: String(error) }
      );
      return false;
    }
    log.info('OIDC configuration applied', {
      providers: [...providers.keys()],
      passwordLogin: config?.passwordLogin,
      maxSessionAgeMs: config?.maxSessionAgeMs,
    });
    return true;
  }

  // ── Routes ──

  const router = hyperdx.rootRouter;

  /** Add a handler at the FRONT of the root router, ahead of HyperDX's own routes. */
  function prepend(handler: Handler) {
    router.use(handler);
    const layer = router.stack.pop();
    router.stack.unshift(layer);
  }

  // Session guard: an OIDC session past its maximum age, or from a provider
  // that has since been removed, is logged out; HyperDX then sees an
  // unauthenticated request and sends the user back to sign in.
  prepend((req, _res, next) => {
    const auth = req.session?.typekroOidcAuth;
    if (auth === undefined || req.user === undefined || config === undefined) {
      next();
      return;
    }
    const expired = config.maxSessionAgeMs > 0 && Date.now() - auth.at > config.maxSessionAgeMs;
    if (!expired && providers.has(auth.provider)) {
      next();
      return;
    }
    req.logout((error) => next(error));
  });

  // Password policy, in two layers, when `passwordLogin` is false.
  //
  // 1. The password strategy itself refuses. Every route that authenticates
  //    with it is covered, however its path is spelled: Express routes match
  //    case-insensitively and with a trailing slash, so a path check alone is
  //    bypassable ("/Login/Password"). The failure message is the one
  //    HyperDX's own error handler maps to `passwordAuthNotAllowed`.
  const localStrategy = hyperdx.passport._strategy('local') as Strategy;
  const originalLocalAuthenticate = localStrategy.authenticate;
  // The one exception: with initialUser owning the instance (createTeam off),
  // HyperDX's first-run registration is how TypeKro's bootstrap claims it, and
  // HyperDX's handler authenticates through this strategy after registering.
  // The exemption is authenticated: only a registration carrying the initial
  // user's own email and password passes (see bootstrap.ts). HyperDX answers
  // 409 teamAlreadyExists to every registration once a team exists, so even
  // that one claims nothing after the bootstrap.
  const bootstrapRegistration = (req: Request) => isBootstrapRegistration(req, options);
  localStrategy.authenticate = function authenticate(this: StrategyContext, req, strategyOptions) {
    if (config !== undefined && !config.passwordLogin && !bootstrapRegistration(req)) {
      this.fail({ message: PASSWORD_NOT_ALLOWED });
      return;
    }
    originalLocalAuthenticate.call(this, req, strategyOptions);
  };
  // 2. The routes that create a password account without the strategy:
  //    first-run registration and team-invite acceptance (which registers
  //    and calls req.login directly). Paths are normalized the way Express
  //    matches them.
  const PASSWORD_ACCOUNT_ROUTES = [/^\/login\/password$/, /^\/register\/password$/, /^\/team\/setup\/[^/]+$/];
  prepend((req, res, next) => {
    if (req.method !== 'POST' || config === undefined || config.passwordLogin || bootstrapRegistration(req)) {
      next();
      return;
    }
    const path = normalizedPath(req);
    if (!PASSWORD_ACCOUNT_ROUTES.some((route) => route.test(path))) {
      next();
      return;
    }
    if (req.session !== undefined) req.session.messages = [PASSWORD_NOT_ALLOWED];
    res.redirect(303, frontend('/login?err=passwordAuthNotAllowed'));
  });

  router.get('/login/oidc', (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    const suffix = returnTo === '/' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
    const list = [...providers.values()];
    if (list.length === 1) {
      res.redirect(302, `${loginPath()}/${(list[0] as ProviderRuntime).config.id}${suffix}`);
      return;
    }
    const passwordHref = config?.passwordLogin === false ? undefined : frontend('/login');
    res
      .status(list.length === 0 ? 503 : 200)
      .type('html')
      .send(
        renderChooser(
          list.map((provider) => ({ label: provider.config.displayName, href: `${loginPath()}/${provider.config.id}${suffix}` })),
          passwordHref
        )
      );
  });

  const authenticate = (req: Request, res: Response, next: Next) => {
    const id = req.params.provider ?? '';
    if (!providers.has(id)) {
      res.status(404).type('html').send(renderDenied('unknownProvider', loginPath()));
      return;
    }
    hyperdx.passport.authenticate(`${STRATEGY_PREFIX}${id}`, (error, user, info) => {
      if (error) {
        next(error);
        return;
      }
      const details = (info ?? {}) as { reason?: string; returnTo?: string };
      if (!user) {
        const status =
          details.reason === 'unknownProvider'
            ? 404
            : ['providerUnavailable', 'instanceNotReady', 'storeUnavailable'].includes(details.reason ?? '')
              ? 503
              : 403;
        res.status(status).type('html').send(renderDenied(details.reason ?? 'unknown', loginPath()));
        return;
      }
      req.logIn(user, (loginError) => {
        if (loginError) {
          next(loginError);
          return;
        }
        // Set after logIn: Passport regenerates the session on login.
        if (req.session !== undefined) req.session.typekroOidcAuth = { provider: id, at: Date.now() };
        res.redirect(302, frontend(safeReturnTo(details.returnTo)));
      });
    })(req, res, next);
  };
  router.get('/login/oidc/:provider', authenticate);
  router.get('/login/oidc/:provider/callback', authenticate);

  reload();
  return { reload, providerIds: () => [...providers.keys()] };
}
