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
import { installPlugin, type Logger, resolveHyperdx } from './hyperdx.js';

const CONFIG_ENV = 'TYPEKRO_HDX_OIDC_CONFIG';
const RELOAD_ENV = 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS';
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
  const apiBuildDir = realpathSync(dirname(entry));
  const rootRouterPath = join(apiBuildDir, 'routers', 'api', 'root.js');
  const moduleInternals = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    _cache: Record<string, { loaded: boolean } | undefined>;
  };
  const originalLoad = moduleInternals._load;
  let done = false;

  moduleInternals._load = function load(this: unknown, request, parent, isMain) {
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!done && moduleInternals._cache[rootRouterPath]?.loaded === true) {
      done = true;
      moduleInternals._load = originalLoad;
      try {
        const plugin = installPlugin(resolveHyperdx(apiBuildDir), configPath, log);
        const seconds = Number(process.env[RELOAD_ENV] ?? '15');
        setInterval(() => plugin.reload(), Math.max(1, Number.isFinite(seconds) ? seconds : 15) * 1000).unref();
        log.info('installed', { providers: plugin.providerIds() });
      } catch (error) {
        log.error('not installed; HyperDX continues without OIDC', { error: String(error) });
      }
    }
    return exported;
  };

  setTimeout(() => {
    if (!done) log.error('HyperDX never loaded its root router; the plugin was not installed', { rootRouterPath });
  }, INSTALL_WARNING_MS).unref();
}

const configPath = process.env[CONFIG_ENV];
const entry = process.argv[1] ?? '';
if (configPath !== undefined && configPath.length > 0 && API_ENTRY.test(entry)) {
  activate(configPath, entry);
}
