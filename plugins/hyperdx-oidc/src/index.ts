/**
 * TypeKro HyperDX OIDC plugin — entry point.
 *
 * Loaded into every Node process in the HyperDX container through
 * `NODE_OPTIONS=--require <this file>` (the image's entry script overwrites the
 * container env it cares about, but not `NODE_OPTIONS`). It activates only in
 * the API process and only when a configuration path is set; everywhere else
 * it returns immediately.
 *
 * It must not load HyperDX, Express or Mongoose itself at preload time: the
 * API's OpenTelemetry instrumentation is registered afterwards and only
 * instruments modules loaded after it. So it waits, via a `Module._load`
 * hook, for HyperDX to finish loading its own root router, installs, and then
 * removes the hook.
 */

import { realpathSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { bootstrapCredentialsFromEnv, readBootstrapPassword } from './bootstrap.js';
import { installPlugin, type Logger, resolveHyperdx } from './hyperdx.js';
import { isSameOriginPath } from './redirects.js';

const CONFIG_ENV = 'TYPEKRO_HDX_OIDC_CONFIG';
const RELOAD_ENV = 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS';
const CREATE_TEAM_ENV = 'TYPEKRO_HDX_OIDC_CREATE_TEAM';
const PASSWORD_LOGIN_PATH_ENV = 'TYPEKRO_HDX_OIDC_PASSWORD_LOGIN_PATH';
const API_ENTRY = /[\\/]packages[\\/]api[\\/]build[\\/]index\.js$/;

const log: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', plugin: 'typekro-oidc', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', plugin: 'typekro-oidc', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', plugin: 'typekro-oidc', message, ...fields })),
};

/** How long after start a missing install is reported (the API loads its router within seconds). */
const INSTALL_WARNING_MS = 60_000;

function activate(configPath: string, entry: string) {
  // The module cache is keyed by real path, so resolve symlinks first.
  let apiBuildDir: string;
  try {
    apiBuildDir = realpathSync(dirname(entry));
  } catch (error) {
    log.error('not installed; could not resolve the API build directory', { error: String(error) });
    return;
  }
  const rootRouterPath = join(apiBuildDir, 'routers', 'api', 'root.js');
  const moduleInternals = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    _cache: Record<string, { loaded: boolean } | undefined>;
  };
  const originalLoad = moduleInternals._load;
  let done = false;

  const hook = function load(this: unknown, request: string, parent: unknown, isMain: boolean) {
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!done && moduleInternals._cache[rootRouterPath]?.loaded === true) {
      done = true;
      // Unhook only if nothing wrapped Module._load after us.
      if (moduleInternals._load === hook) moduleInternals._load = originalLoad;
      try {
        const createTeam = process.env[CREATE_TEAM_ENV] !== 'false';
        // Only meaningful when something else claims the instance. Never log the password.
        const bootstrap = createTeam ? undefined : bootstrapCredentialsFromEnv(process.env);
        if (!createTeam && bootstrap === undefined) {
          log.warn(
            'no initial-user bootstrap credentials; with passwordLogin: false, first-run registration is refused'
          );
        } else if (bootstrap !== undefined && readBootstrapPassword(bootstrap.passwordFile) === undefined) {
          // Armed anyway: the file is re-read on every registration attempt, so
          // a key added to the Secret later takes effect without a restart.
          log.warn(
            'initial-user bootstrap password file is absent or empty; with passwordLogin: false, first-run registration is refused until it appears',
            { passwordFile: bootstrap.passwordFile }
          );
        }
        // Set by the wiring from `hyperdxOidc.passwordLoginPath`, which
        // validates it; checked again here, as it becomes a redirect target.
        const envPasswordLoginPath = process.env[PASSWORD_LOGIN_PATH_ENV];
        const passwordLoginPath =
          envPasswordLoginPath !== undefined && isSameOriginPath(envPasswordLoginPath) ? envPasswordLoginPath : undefined;
        if (envPasswordLoginPath !== undefined && passwordLoginPath === undefined) {
          log.warn('ignoring a password login path that is not a same-origin path', { env: PASSWORD_LOGIN_PATH_ENV });
        }
        const plugin = installPlugin(resolveHyperdx(apiBuildDir), configPath, log, {
          createTeam,
          ...(bootstrap !== undefined && { bootstrap }),
          ...(passwordLoginPath !== undefined && { passwordLoginPath }),
        });
        const seconds = Number(process.env[RELOAD_ENV] ?? '15');
        setInterval(() => plugin.reload(), Math.max(1, Number.isFinite(seconds) ? seconds : 15) * 1000).unref();
        log.info('installed', { providers: plugin.providerIds() });
      } catch (error) {
        log.error('not installed; HyperDX continues without OIDC', { error: String(error) });
      }
    }
    return exported;
  };
  moduleInternals._load = hook;

  setTimeout(() => {
    if (!done) log.error('HyperDX never loaded its root router; the plugin was not installed', { rootRouterPath });
  }, INSTALL_WARNING_MS).unref();
}

const configPath = process.env[CONFIG_ENV];
const entry = process.argv[1] ?? '';
if (configPath !== undefined && configPath.length > 0 && API_ENTRY.test(entry)) {
  activate(configPath, entry);
}
