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

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type OidcPluginConfig, parseOidcPluginConfig } from './config.js';
import { evaluateClaims, type IdentityStore, resolveAccount, type VerifiedIdentity } from './identity.js';
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

interface Passport {
  use(name: string, strategy: { name: string; authenticate(this: StrategyContext, req: Request): void }): void;
  unuse(name: string): void;
  authenticate(name: string, callback: (error: unknown, user: unknown, info: unknown) => void): Handler;
}

interface MongooseModel {
  findOne(filter: Record<string, unknown>): { select(fields: string): { lean(): Promise<unknown> } };
  find(filter: Record<string, unknown>): { select(fields: string): { limit(n: number): { lean(): Promise<unknown[]> } } };
  findById(id: string): Promise<unknown>;
  create(doc: Record<string, unknown>): Promise<{ _id: { toString(): string } }>;
  db: { collection(name: string): Collection };
}

interface Collection {
  createIndex(spec: Record<string, number>, options: Record<string, unknown>): Promise<unknown>;
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
    ['routers/api/root router', Array.isArray(rootRouter?.stack) && typeof rootRouter?.get === 'function'],
    ['models/user', typeof User?.findOne === 'function' && typeof User?.create === 'function'],
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

function mongoIdentityStore(hyperdx: Hyperdx, config: () => OidcPluginConfig, log: Logger): IdentityStore {
  const links = hyperdx.User.db.collection(IDENTITY_COLLECTION);
  links
    .createIndex({ provider: 1, subject: 1 }, { unique: true, name: 'provider_subject' })
    .catch((error: unknown) => log.error('could not create the identity-link index', { error: String(error) }));

  async function newUserTeamId(email: string): Promise<string> {
    const configured = config().teamId;
    if (configured !== undefined) {
      const team = await hyperdx.Team.findById(configured);
      if (team === null) throw new Error(`configured teamId ${configured} does not exist`);
      return configured;
    }
    const teams = (await hyperdx.Team.find({}).select('_id').limit(2).lean()) as Array<{ _id: { toString(): string } }>;
    if (teams.length === 1) return (teams[0] as { _id: { toString(): string } })._id.toString();
    if (teams.length > 1) throw new Error('more than one HyperDX team exists; set teamId in the OIDC configuration');
    // No team yet: this login claims the instance, exactly as HyperDX's own
    // first registration does (create the team, then its default sources).
    const team = await hyperdx.createTeam({ name: `${email}'s Team`, collectorAuthenticationEnforced: true });
    const teamId = team._id.toString();
    await hyperdx.setupTeamDefaults(teamId).catch((error: unknown) =>
      log.error('setting up default connections and sources for the new team failed', { error: String(error) })
    );
    return teamId;
  }

  return {
    async findLinkedUserId(provider, subject) {
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
    async createUser(email, name) {
      const team = await newUserTeamId(email);
      const user = await hyperdx.User.create({ email, name, team });
      return user._id.toString();
    },
    async link(identity: VerifiedIdentity, userId) {
      const now = new Date();
      await links.updateOne(
        { provider: identity.provider, subject: identity.subject },
        { $set: { userId, email: identity.email, lastLoginAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
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
export function installPlugin(hyperdx: Hyperdx, configPath: string, log: Logger): InstalledPlugin {
  let config: OidcPluginConfig | undefined;
  let lastText: string | undefined;
  let providers = new Map<string, ProviderRuntime>();
  const store = mongoIdentityStore(
    hyperdx,
    () => config ?? parseOidcPluginConfig('{"providers":[]}'),
    log
  );

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
            this.fail({ reason: error.reason }, error.reason === 'providerUnavailable' ? 503 : 400);
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
      if (config === undefined) log.error('OIDC configuration unreadable; no providers active', { path: configPath, error: String(error) });
      return false;
    }
    if (text === lastText) return false;
    lastText = text;
    try {
      apply(parseOidcPluginConfig(text));
    } catch (error) {
      // Keep serving the last good configuration.
      log.error('OIDC configuration rejected; keeping the previous one', { error: String(error) });
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

  // Password policy: HyperDX's own login and first-run registration are
  // refused when `passwordLogin` is false. The redirect lands on HyperDX's
  // login page with the error it already has copy for.
  prepend((req, res, next) => {
    const passwordRoute = req.path === '/login/password' || req.path === '/register/password';
    if (req.method !== 'POST' || !passwordRoute || config === undefined || config.passwordLogin) {
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
    hyperdx.passport.authenticate(`${STRATEGY_PREFIX}${id}`, (error, user, info) => {
      if (error) {
        next(error);
        return;
      }
      const details = (info ?? {}) as { reason?: string; returnTo?: string };
      if (!user) {
        const status = details.reason === 'unknownProvider' ? 404 : details.reason === 'providerUnavailable' ? 503 : 403;
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
