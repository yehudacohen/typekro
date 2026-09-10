/**
 * Repo-wide inventory of literal status leaves in the bundled compositions (#188).
 *
 * `literal-status-validation.test.ts` pins the check itself. This one points it
 * at every composition shipped under `src/factories` and asserts the result
 * against a checked-in inventory, so the set can only shrink: fixing a
 * composition fails this test until its entry is deleted, and introducing a new
 * literal leaf fails it until the leaf is projected or the entry is added with
 * a reason.
 *
 * The inventory is not an approval. Every entry below is a status field that
 * KRO leaves unset on the instance today — see the PR for why none of them are
 * a one-line fix. Several are not authored literals at all but the
 * JavaScript-to-CEL analyzer degrading: `pebble`'s
 * `conditions?.some(...) || false` cannot be expressed in CEL, so the leaf
 * collapses to the `|| false` fallback and the field ends up absent rather
 * than `false`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FACTORIES_DIR = join(import.meta.dir, '..', '..', 'src', 'factories');

/**
 * Status paths KRO drops today, keyed by `<factory>::<export>`.
 *
 * Sorted by path so a diff reads as one added or removed field. Delete an
 * entry when its composition starts projecting; delete the key when it is
 * clean.
 */
const KNOWN_LITERAL_STATUS_LEAVES: Readonly<Record<string, readonly string[]>> = {
  // Fixed service ports and schemes. Projecting them needs a ConfigMap per
  // endpoint, which is a design change rather than a status edit.
  'apisix::apisixBootstrap': [
    'status.gatewayService.ports[0].name',
    'status.gatewayService.ports[0].protocol',
    'status.gatewayService.ports[1].name',
    'status.gatewayService.ports[1].protocol',
    'status.standardIngressReady',
  ],
  // `crds.installed: true` is a documented workaround for unresolved nested CEL
  // in direct mode; see the comment in cert-manager-bootstrap.ts.
  'cert-manager::certManagerBootstrap': ['status.crds.installed'],
  // Analyzer degradation: the counters and the boolean are `0`/`false`
  // fallbacks behind expressions CEL cannot represent.
  'cilium::ciliumBootstrap': [
    'status.cni.binPath',
    'status.cni.configPath',
    'status.cni.socketPath',
    'status.resources.readyNodes',
    'status.resources.totalEndpoints',
    'status.resources.totalIdentities',
    'status.resources.totalNodes',
    'status.security.authenticationEnabled',
  ],
  // Owned by an in-flight PR — inventoried, not touched.
  'clickhouse::clickHouseCluster': ['status.clickhouse.database', 'status.clickhouse.port'],
  // Owned by an in-flight PR — inventoried, not touched.
  'clickstack::clickstackBootstrap': ['status.app.apiPort', 'status.app.appPort'],
  // Record counters with no resource in the graph to project them from.
  'external-dns::externalDnsBootstrap': [
    'status.records.errors',
    'status.records.managed',
    'status.records.total',
  ],
  // `controllerSpec.version ?? DEFAULT_NACK_VERSION` resolves off a plain
  // object rather than the schema proxy, so it lands as a literal.
  'nats::natsBootstrap': ['status.controllerVersion'],
  'nats::natsInstallation': ['status.controllerVersion'],
  'ory::oryIdentityStack': [
    'status.endpoints.hydraAdmin.port',
    'status.endpoints.hydraAdmin.scheme',
    'status.endpoints.hydraPublic.port',
    'status.endpoints.hydraPublic.scheme',
    'status.endpoints.ketoRead.port',
    'status.endpoints.ketoRead.scheme',
    'status.endpoints.ketoWrite.port',
    'status.endpoints.ketoWrite.scheme',
    'status.endpoints.kratosAdmin.port',
    'status.endpoints.kratosAdmin.scheme',
    'status.endpoints.kratosPublic.port',
    'status.endpoints.kratosPublic.scheme',
    'status.endpoints.oathkeeperApi.port',
    'status.endpoints.oathkeeperApi.scheme',
    'status.endpoints.oathkeeperProxy.port',
    'status.endpoints.oathkeeperProxy.scheme',
  ],
  'ory::oryPlatformStack': [
    'status.endpoints.hydraAdmin.port',
    'status.endpoints.hydraAdmin.scheme',
    'status.endpoints.hydraPublic.port',
    'status.endpoints.hydraPublic.scheme',
    'status.endpoints.ketoRead.port',
    'status.endpoints.ketoRead.scheme',
    'status.endpoints.ketoWrite.port',
    'status.endpoints.ketoWrite.scheme',
    'status.endpoints.kratosAdmin.port',
    'status.endpoints.kratosAdmin.scheme',
    'status.endpoints.kratosPublic.port',
    'status.endpoints.kratosPublic.scheme',
    'status.endpoints.oathkeeperApi.port',
    'status.endpoints.oathkeeperApi.scheme',
    'status.endpoints.oathkeeperProxy.port',
    'status.endpoints.oathkeeperProxy.scheme',
    'status.infrastructure.routes',
    'status.ory.endpoints.hydraAdmin.port',
    'status.ory.endpoints.hydraAdmin.scheme',
    'status.ory.endpoints.hydraPublic.port',
    'status.ory.endpoints.hydraPublic.scheme',
    'status.ory.endpoints.ketoRead.port',
    'status.ory.endpoints.ketoRead.scheme',
    'status.ory.endpoints.ketoWrite.port',
    'status.ory.endpoints.ketoWrite.scheme',
    'status.ory.endpoints.kratosAdmin.port',
    'status.ory.endpoints.kratosAdmin.scheme',
    'status.ory.endpoints.kratosPublic.port',
    'status.ory.endpoints.kratosPublic.scheme',
    'status.ory.endpoints.oathkeeperApi.port',
    'status.ory.endpoints.oathkeeperApi.scheme',
    'status.ory.endpoints.oathkeeperProxy.port',
    'status.ory.endpoints.oathkeeperProxy.scheme',
  ],
  // Analyzer degradation on `conditions?.some(...) || false`.
  'pebble::pebbleBootstrap': [
    'status.corednsReady',
    'status.pebbleReady',
    'status.ready',
  ],
  'webapp::webAppWithProcessing': ['status.cachePort', 'status.databasePort'],
};

/**
 * Compositions that cannot be serialized in KRO mode at all, and why.
 *
 * Recorded rather than skipped: a composition dropping out of the scan should
 * be a visible decision, not a silent gap in coverage.
 */
const NOT_KRO_SERIALIZABLE: Readonly<Record<string, string>> = {
  'rook::rookObjectStorageClaim': 'direct mode only — declares supportedModes: [direct]',
};

/**
 * Credentials some bootstraps demand before their composition function will
 * run. Placeholders: the scan serializes, it never connects to anything.
 */
const SCAN_ENV: Readonly<Record<string, string>> = {
  APISIX_ADMIN_KEY: 'literal-status-scan-placeholder',
  APISIX_VIEWER_KEY: 'literal-status-scan-placeholder',
};

interface ScanResult {
  readonly flagged: Record<string, string[]>;
  readonly unscannable: Record<string, string>;
}

/** Every `src/factories/<name>` entry point that might export compositions. */
function compositionModules(): { factory: string; path: string }[] {
  const modules: { factory: string; path: string }[] = [];
  for (const factory of readdirSync(FACTORIES_DIR).sort()) {
    for (const relative of [join('compositions', 'index.ts'), 'index.ts']) {
      const path = join(FACTORIES_DIR, factory, relative);
      try {
        if (statSync(path).isFile()) {
          modules.push({ factory, path });
          break;
        }
      } catch {
        // Not every factory ships compositions.
      }
    }
  }
  return modules;
}

async function scanBundledCompositions(): Promise<ScanResult> {
  const restore: [string, string | undefined][] = Object.entries(SCAN_ENV).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = previous ?? value;
    return [key, previous];
  });

  const flagged: Record<string, string[]> = {};
  const unscannable: Record<string, string> = {};

  try {
    for (const { factory, path } of compositionModules()) {
      const module = (await import(path)) as Record<string, unknown>;

      for (const [exportName, value] of Object.entries(module)) {
        const graph = value as
          | { factory?: (mode: string, options?: unknown) => { toYaml: () => string } }
          | undefined;
        if (!graph || typeof graph.factory !== 'function') continue;

        const key = `${factory}::${exportName}`;
        try {
          graph.factory('kro', { allowLiteralStatus: false }).toYaml();
        } catch (error) {
          const failure = error as {
            code?: string;
            context?: { leaves?: { path: string }[] };
            message?: string;
          };
          if (failure?.code === 'KRO_LITERAL_STATUS_LEAF') {
            flagged[key] = (failure.context?.leaves ?? []).map((leaf) => leaf.path).sort();
          } else {
            unscannable[key] = failure?.message ?? String(error);
          }
        }
      }
    }
  } finally {
    for (const [key, previous] of restore) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }

  return { flagged, unscannable };
}

describe('bundled compositions: literal status leaves (#188)', () => {
  it('flags exactly the inventoried compositions, and no others', async () => {
    const { flagged } = await scanBundledCompositions();

    expect(Object.keys(flagged).sort()).toEqual(Object.keys(KNOWN_LITERAL_STATUS_LEAVES).sort());
  });

  it('flags exactly the inventoried status paths within each composition', async () => {
    const { flagged } = await scanBundledCompositions();

    for (const [key, expected] of Object.entries(KNOWN_LITERAL_STATUS_LEAVES)) {
      // Named per composition so a failure says which one moved.
      expect({ [key]: flagged[key] }).toEqual({ [key]: [...expected] });
    }
  });

  it('records every composition that cannot be scanned in KRO mode', async () => {
    const { unscannable } = await scanBundledCompositions();

    expect(Object.keys(unscannable).sort()).toEqual(Object.keys(NOT_KRO_SERIALIZABLE).sort());
  });

  it('scans a meaningful number of compositions', async () => {
    // Guards the walk itself: an import path change that silently found
    // nothing would otherwise pass every assertion above.
    const modules = compositionModules();
    expect(modules.length).toBeGreaterThan(15);
  });
});
