/**
 * Repo-wide inventory of the status leaves KRO drops from the bundled
 * compositions (#188).
 *
 * `literal-status-validation.test.ts` pins the check itself. This one points it
 * at every composition shipped under `src/factories` and asserts the result
 * against a checked-in inventory.
 *
 * RATCHET DIRECTION. The inventory can only SHRINK. A composition that grows a
 * new dropped leaf FAILS this test; a composition that starts projecting one
 * does NOT fail — the run reports the stale entries and asks for the fixture to
 * be trimmed. Failing in both directions made an unrelated serialization
 * improvement break the build, which is the wrong incentive: nothing here
 * should ever discourage fixing a composition.
 *
 * DETERMINISM. The scan runs exactly ONCE, at module load, and every case reads
 * that one result synchronously. It used to re-serialize all ~90 exported
 * graphs per case, which made the file both slow and order-sensitive —
 * serializing the same graph object repeatedly is not guaranteed to be
 * idempotent, so a case could see a different inventory than the one before it
 * depending on which ran first. Hoisting the walk out of the cases also keeps
 * its cost off the timeout budget: no case needs a raised timeout, and none can
 * inherit the scan by running first. Nothing below depends on test order,
 * wall-clock time, or the filesystem beyond the module list.
 *
 * The inventory is not an approval. Every entry is a status field that KRO
 * leaves unset on the instance today, in one of two shapes:
 *
 *   'literal'          a bare constant — or an expression the JS-to-CEL analyzer
 *                      degraded into one. Several entries are not authored
 *                      literals at all: `pebble`'s `conditions?.some(...) ||
 *                      false` cannot be expressed in CEL, so the leaf collapses
 *                      to the `|| false` fallback and the field ends up absent
 *                      rather than `false`.
 *
 *   'schema-reference' a bare `schema.spec.*` echo. KRO requires every status
 *                      field to refer to a RESOURCE and its status CEL has no
 *                      `schema` identifier, so these are dropped exactly like
 *                      literals. By far the most common instance is
 *                      `status.version = spec.version`: sixteen compositions
 *                      advertise a version field their CR never carries.
 *
 * None are a one-line fix — projecting a spec value means routing it through a
 * resource this graph owns (echo it into a ConfigMap or an annotation and read
 * it back), which is a composition change rather than a status edit. See the PR.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { DroppedStatusLeafKind } from '../../src/core/validation/literal-status.js';

const FACTORIES_DIR = join(import.meta.dir, '..', '..', 'src', 'factories');

/**
 * Status leaves KRO drops today, keyed by `<factory>::<export>` and then by
 * status path, with the shape that makes each one unrepresentable.
 *
 * Sorted by key and by path so a diff reads as one added or removed field.
 * Delete a path when its composition starts projecting it; delete the whole key
 * when the composition is clean.
 */
const KNOWN_DROPPED_STATUS_LEAVES: Readonly<
  Record<string, Readonly<Record<string, DroppedStatusLeafKind>>>
> = {
  // Service shape echoed straight back out of the spec (ports, type,
  // namespace) plus fixed port names/protocols. Projecting it needs the
  // Service's own `spec.ports`, which is a composition change, not a status edit.
  'apisix::apisixBootstrap': {
    'status.gatewayService.namespace': 'schema-reference',
    'status.gatewayService.ports[0].name': 'literal',
    'status.gatewayService.ports[0].port': 'schema-reference',
    'status.gatewayService.ports[0].protocol': 'literal',
    'status.gatewayService.ports[0].targetPort': 'schema-reference',
    'status.gatewayService.ports[1].name': 'literal',
    'status.gatewayService.ports[1].port': 'schema-reference',
    'status.gatewayService.ports[1].protocol': 'literal',
    'status.gatewayService.ports[1].targetPort': 'schema-reference',
    'status.gatewayService.type': 'schema-reference',
    'status.standardIngressReady': 'literal',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'caddy::caddyIngress': {
    'status.version': 'schema-reference',
  },
  // `crds.installed: true` is a documented workaround for unresolved nested CEL
  // in direct mode; see the comment in cert-manager-bootstrap.ts. The two
  // versions are the spec echo described above.
  'cert-manager::certManagerBootstrap': {
    'status.crds.installed': 'literal',
    'status.crds.version': 'schema-reference',
    'status.version': 'schema-reference',
  },
  // Two shapes at once: the counters and booleans are `0`/`false` fallbacks
  // behind expressions CEL cannot represent (analyzer degradation), and the
  // networking/security mode fields echo the spec that configured them.
  'cilium::ciliumBootstrap': {
    'status.bgpEnabled': 'schema-reference',
    'status.cni.binPath': 'literal',
    'status.cni.configPath': 'literal',
    'status.cni.socketPath': 'literal',
    'status.encryptionEnabled': 'schema-reference',
    'status.gatewayAPIEnabled': 'schema-reference',
    'status.networking.ipamMode': 'schema-reference',
    'status.networking.kubeProxyReplacement': 'schema-reference',
    'status.networking.routingMode': 'schema-reference',
    'status.networking.tunnelProtocol': 'schema-reference',
    'status.resources.readyNodes': 'literal',
    'status.resources.totalEndpoints': 'literal',
    'status.resources.totalIdentities': 'literal',
    'status.resources.totalNodes': 'literal',
    'status.security.authenticationEnabled': 'literal',
    'status.security.encryptionStatus': 'schema-reference',
    'status.security.policyEnforcement': 'schema-reference',
    'status.version': 'schema-reference',
  },
  // Owned by an in-flight PR — inventoried, not touched.
  'clickhouse::clickHouseCluster': {
    'status.clickhouse.database': 'literal',
    'status.clickhouse.port': 'literal',
  },
  // Owned by an in-flight PR — inventoried, not touched.
  'clickhouse::clickhouseOperatorBootstrap': {
    'status.version': 'schema-reference',
  },
  // Owned by an in-flight PR — inventoried, not touched.
  'clickstack::clickstackBootstrap': {
    'status.app.apiPort': 'literal',
    'status.app.appPort': 'literal',
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'cnpg::cnpgBootstrap': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'dagster::dagsterBootstrap': {
    'status.version': 'schema-reference',
  },
  // Record counters with no resource in the graph to project them from, plus
  // the provider/policy/filter settings echoed back from the spec.
  'external-dns::externalDnsBootstrap': {
    'status.dnsProvider': 'schema-reference',
    'status.domainFilters': 'schema-reference',
    'status.dryRun': 'schema-reference',
    'status.policy': 'schema-reference',
    'status.records.errors': 'literal',
    'status.records.managed': 'literal',
    'status.records.total': 'literal',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'inngest::inngestBootstrap': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'nats::nackControllerBootstrap': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'nats::nackControllerInstallation': {
    'status.version': 'schema-reference',
  },
  // `controllerSpec.version ?? DEFAULT_NACK_VERSION` resolves off a plain
  // object rather than the schema proxy, so it lands as a literal. `endpoint`
  // and `serverVersion` are spec echoes.
  'nats::natsBootstrap': {
    'status.controllerVersion': 'literal',
    'status.endpoint': 'schema-reference',
    'status.serverVersion': 'schema-reference',
  },
  'nats::natsInstallation': {
    'status.controllerVersion': 'literal',
    'status.endpoint': 'schema-reference',
    'status.serverVersion': 'schema-reference',
  },
  // Endpoint tables assembled from spec-derived hosts, namespaces and fixed
  // ports/schemes. Projecting them needs a Service read per endpoint.
  'ory::oryIdentityStack': {
    'status.endpoints.hydraAdmin.namespace': 'schema-reference',
    'status.endpoints.hydraAdmin.port': 'literal',
    'status.endpoints.hydraAdmin.scheme': 'literal',
    'status.endpoints.hydraPublic.namespace': 'schema-reference',
    'status.endpoints.hydraPublic.port': 'literal',
    'status.endpoints.hydraPublic.scheme': 'literal',
    'status.endpoints.ketoRead.namespace': 'schema-reference',
    'status.endpoints.ketoRead.port': 'literal',
    'status.endpoints.ketoRead.scheme': 'literal',
    'status.endpoints.ketoWrite.namespace': 'schema-reference',
    'status.endpoints.ketoWrite.port': 'literal',
    'status.endpoints.ketoWrite.scheme': 'literal',
    'status.endpoints.kratosAdmin.namespace': 'schema-reference',
    'status.endpoints.kratosAdmin.port': 'literal',
    'status.endpoints.kratosAdmin.scheme': 'literal',
    'status.endpoints.kratosPublic.namespace': 'schema-reference',
    'status.endpoints.kratosPublic.port': 'literal',
    'status.endpoints.kratosPublic.scheme': 'literal',
    'status.endpoints.oathkeeperApi.namespace': 'schema-reference',
    'status.endpoints.oathkeeperApi.port': 'literal',
    'status.endpoints.oathkeeperApi.scheme': 'literal',
    'status.endpoints.oathkeeperProxy.namespace': 'schema-reference',
    'status.endpoints.oathkeeperProxy.port': 'literal',
    'status.endpoints.oathkeeperProxy.scheme': 'literal',
    'status.version': 'schema-reference',
  },
  // The largest offender by far: every endpoint field, the dependency flags and
  // the duplicated `status.ory.*` mirror are built from spec values and fixed
  // constants, with no Service read anywhere.
  'ory::oryPlatformStack': {
    'status.dependencies.courier': 'schema-reference',
    'status.dependencies.hydraDatabase': 'schema-reference',
    'status.dependencies.ketoDatabase': 'schema-reference',
    'status.dependencies.kratosDatabase': 'schema-reference',
    'status.dependencies.routes': 'schema-reference',
    'status.dependencies.secrets': 'schema-reference',
    'status.dependencies.upstream': 'schema-reference',
    'status.endpoints.hydraAdmin.host': 'schema-reference',
    'status.endpoints.hydraAdmin.namespace': 'schema-reference',
    'status.endpoints.hydraAdmin.port': 'literal',
    'status.endpoints.hydraAdmin.scheme': 'literal',
    'status.endpoints.hydraAdmin.serviceName': 'schema-reference',
    'status.endpoints.hydraAdmin.url': 'schema-reference',
    'status.endpoints.hydraPublic.host': 'schema-reference',
    'status.endpoints.hydraPublic.namespace': 'schema-reference',
    'status.endpoints.hydraPublic.port': 'literal',
    'status.endpoints.hydraPublic.scheme': 'literal',
    'status.endpoints.hydraPublic.serviceName': 'schema-reference',
    'status.endpoints.hydraPublic.url': 'schema-reference',
    'status.endpoints.ketoRead.host': 'schema-reference',
    'status.endpoints.ketoRead.namespace': 'schema-reference',
    'status.endpoints.ketoRead.port': 'literal',
    'status.endpoints.ketoRead.scheme': 'literal',
    'status.endpoints.ketoRead.serviceName': 'schema-reference',
    'status.endpoints.ketoRead.url': 'schema-reference',
    'status.endpoints.ketoWrite.host': 'schema-reference',
    'status.endpoints.ketoWrite.namespace': 'schema-reference',
    'status.endpoints.ketoWrite.port': 'literal',
    'status.endpoints.ketoWrite.scheme': 'literal',
    'status.endpoints.ketoWrite.serviceName': 'schema-reference',
    'status.endpoints.ketoWrite.url': 'schema-reference',
    'status.endpoints.kratosAdmin.host': 'schema-reference',
    'status.endpoints.kratosAdmin.namespace': 'schema-reference',
    'status.endpoints.kratosAdmin.port': 'literal',
    'status.endpoints.kratosAdmin.scheme': 'literal',
    'status.endpoints.kratosAdmin.serviceName': 'schema-reference',
    'status.endpoints.kratosAdmin.url': 'schema-reference',
    'status.endpoints.kratosPublic.host': 'schema-reference',
    'status.endpoints.kratosPublic.namespace': 'schema-reference',
    'status.endpoints.kratosPublic.port': 'literal',
    'status.endpoints.kratosPublic.scheme': 'literal',
    'status.endpoints.kratosPublic.serviceName': 'schema-reference',
    'status.endpoints.kratosPublic.url': 'schema-reference',
    'status.endpoints.oathkeeperApi.host': 'schema-reference',
    'status.endpoints.oathkeeperApi.namespace': 'schema-reference',
    'status.endpoints.oathkeeperApi.port': 'literal',
    'status.endpoints.oathkeeperApi.scheme': 'literal',
    'status.endpoints.oathkeeperApi.serviceName': 'schema-reference',
    'status.endpoints.oathkeeperApi.url': 'schema-reference',
    'status.endpoints.oathkeeperProxy.host': 'schema-reference',
    'status.endpoints.oathkeeperProxy.namespace': 'schema-reference',
    'status.endpoints.oathkeeperProxy.port': 'literal',
    'status.endpoints.oathkeeperProxy.scheme': 'literal',
    'status.endpoints.oathkeeperProxy.serviceName': 'schema-reference',
    'status.endpoints.oathkeeperProxy.url': 'schema-reference',
    'status.infrastructure.courier': 'schema-reference',
    'status.infrastructure.databases': 'schema-reference',
    'status.infrastructure.routes': 'literal',
    'status.infrastructure.secrets': 'schema-reference',
    'status.infrastructure.upstream': 'schema-reference',
    'status.ory.endpoints.hydraAdmin.host': 'schema-reference',
    'status.ory.endpoints.hydraAdmin.namespace': 'schema-reference',
    'status.ory.endpoints.hydraAdmin.port': 'literal',
    'status.ory.endpoints.hydraAdmin.scheme': 'literal',
    'status.ory.endpoints.hydraAdmin.serviceName': 'schema-reference',
    'status.ory.endpoints.hydraAdmin.url': 'schema-reference',
    'status.ory.endpoints.hydraPublic.host': 'schema-reference',
    'status.ory.endpoints.hydraPublic.namespace': 'schema-reference',
    'status.ory.endpoints.hydraPublic.port': 'literal',
    'status.ory.endpoints.hydraPublic.scheme': 'literal',
    'status.ory.endpoints.hydraPublic.serviceName': 'schema-reference',
    'status.ory.endpoints.hydraPublic.url': 'schema-reference',
    'status.ory.endpoints.ketoRead.host': 'schema-reference',
    'status.ory.endpoints.ketoRead.namespace': 'schema-reference',
    'status.ory.endpoints.ketoRead.port': 'literal',
    'status.ory.endpoints.ketoRead.scheme': 'literal',
    'status.ory.endpoints.ketoRead.serviceName': 'schema-reference',
    'status.ory.endpoints.ketoRead.url': 'schema-reference',
    'status.ory.endpoints.ketoWrite.host': 'schema-reference',
    'status.ory.endpoints.ketoWrite.namespace': 'schema-reference',
    'status.ory.endpoints.ketoWrite.port': 'literal',
    'status.ory.endpoints.ketoWrite.scheme': 'literal',
    'status.ory.endpoints.ketoWrite.serviceName': 'schema-reference',
    'status.ory.endpoints.ketoWrite.url': 'schema-reference',
    'status.ory.endpoints.kratosAdmin.host': 'schema-reference',
    'status.ory.endpoints.kratosAdmin.namespace': 'schema-reference',
    'status.ory.endpoints.kratosAdmin.port': 'literal',
    'status.ory.endpoints.kratosAdmin.scheme': 'literal',
    'status.ory.endpoints.kratosAdmin.serviceName': 'schema-reference',
    'status.ory.endpoints.kratosAdmin.url': 'schema-reference',
    'status.ory.endpoints.kratosPublic.host': 'schema-reference',
    'status.ory.endpoints.kratosPublic.namespace': 'schema-reference',
    'status.ory.endpoints.kratosPublic.port': 'literal',
    'status.ory.endpoints.kratosPublic.scheme': 'literal',
    'status.ory.endpoints.kratosPublic.serviceName': 'schema-reference',
    'status.ory.endpoints.kratosPublic.url': 'schema-reference',
    'status.ory.endpoints.oathkeeperApi.host': 'schema-reference',
    'status.ory.endpoints.oathkeeperApi.namespace': 'schema-reference',
    'status.ory.endpoints.oathkeeperApi.port': 'literal',
    'status.ory.endpoints.oathkeeperApi.scheme': 'literal',
    'status.ory.endpoints.oathkeeperApi.serviceName': 'schema-reference',
    'status.ory.endpoints.oathkeeperApi.url': 'schema-reference',
    'status.ory.endpoints.oathkeeperProxy.host': 'schema-reference',
    'status.ory.endpoints.oathkeeperProxy.namespace': 'schema-reference',
    'status.ory.endpoints.oathkeeperProxy.port': 'literal',
    'status.ory.endpoints.oathkeeperProxy.scheme': 'literal',
    'status.ory.endpoints.oathkeeperProxy.serviceName': 'schema-reference',
    'status.ory.endpoints.oathkeeperProxy.url': 'schema-reference',
    'status.ory.version': 'schema-reference',
  },
  // Analyzer degradation on `conditions?.some(...) || false`, plus the
  // management endpoint and version echoed from the spec.
  'pebble::pebbleBootstrap': {
    'status.corednsReady': 'literal',
    'status.managementEndpoint': 'schema-reference',
    'status.pebbleReady': 'literal',
    'status.ready': 'literal',
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'rook::rookCephOperatorBootstrap': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'rook::rookCephOperatorInstallation': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'valkey::valkeyBootstrap': {
    'status.version': 'schema-reference',
  },
  // `status.version` echoes `spec.version` and nothing else.
  'valkey::valkeyOperatorInstallation': {
    'status.version': 'schema-reference',
  },
  // Ports are fixed constants; the three URLs are template literals over spec
  // values only, with no resource reference to anchor them.
  'webapp::webAppWithProcessing': {
    'status.appUrl': 'schema-reference',
    'status.cachePort': 'literal',
    'status.cacheUrl': 'schema-reference',
    'status.databasePort': 'literal',
    'status.inngestUrl': 'schema-reference',
  },
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

/** One composition's dropped leaves, as `path -> kind`. */
type LeafInventory = Record<string, DroppedStatusLeafKind>;

interface ScanResult {
  readonly flagged: Record<string, LeafInventory>;
  readonly unscannable: Record<string, string>;
  readonly moduleCount: number;
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

/** Sort an inventory by path so every comparison and diff is stable. */
function sortLeaves(leaves: LeafInventory): LeafInventory {
  return Object.fromEntries(
    Object.entries(leaves).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
}

async function scanBundledCompositions(): Promise<ScanResult> {
  const restore: [string, string | undefined][] = Object.entries(SCAN_ENV).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = previous ?? value;
    return [key, previous];
  });

  const flagged: Record<string, LeafInventory> = {};
  const unscannable: Record<string, string> = {};
  const modules = compositionModules();

  try {
    for (const { factory, path } of modules) {
      const module = (await import(path)) as Record<string, unknown>;

      for (const [exportName, value] of Object.entries(module)) {
        const graph = value as
          | { factory?: (mode: string, options?: unknown) => { toYaml: () => string } }
          | undefined;
        if (!graph || typeof graph.factory !== 'function') continue;

        const key = `${factory}::${exportName}`;
        try {
          // Serialized exactly once per composition, for the whole file.
          graph.factory('kro', { allowLiteralStatus: false }).toYaml();
        } catch (error) {
          const failure = error as {
            code?: string;
            context?: { leaves?: { path: string; kind: DroppedStatusLeafKind }[] };
            message?: string;
          };
          if (failure?.code === 'KRO_LITERAL_STATUS_LEAF') {
            flagged[key] = sortLeaves(
              Object.fromEntries(
                (failure.context?.leaves ?? []).map((leaf) => [leaf.path, leaf.kind])
              )
            );
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

  return { flagged, unscannable, moduleCount: modules.length };
}

/**
 * The single scan, shared by every case in this file.
 *
 * Run at module load rather than lazily from whichever case happens to go
 * first: the walk costs the FILE once, every case below is synchronous, and
 * reordering or filtering the cases cannot change what any of them sees or how
 * long it has. It also keeps the walk out of the per-test timeout budget
 * entirely, so no case needs a raised timeout to pay for it. (Top-level await
 * in a test module is the same pattern the integration suites use for their
 * cluster probe.)
 */
const scan: ScanResult = await scanBundledCompositions();

describe('bundled compositions: dropped status leaves (#188)', () => {
  it('flags no composition that is not inventoried', () => {
    const { flagged } = scan;

    const uninventoried = Object.keys(flagged)
      .filter((key) => !(key in KNOWN_DROPPED_STATUS_LEAVES))
      .sort();

    expect(uninventoried).toEqual([]);
  });

  it('flags no status path that is not inventoried', () => {
    const { flagged } = scan;

    for (const [key, expected] of Object.entries(KNOWN_DROPPED_STATUS_LEAVES)) {
      const actual = flagged[key] ?? {};
      // Only paths present in the scan are asserted, so a composition that
      // started projecting a field cannot fail this case — the shrink is
      // reported by `notes inventory entries that no longer reproduce`.
      const regressions = Object.entries(actual)
        .filter(([path, kind]) => expected[path] !== kind)
        .map(([path, kind]) => `${path} (${kind})`)
        .sort();

      // Named per composition so a failure says which one moved.
      expect({ [key]: regressions }).toEqual({ [key]: [] });
    }
  });

  it('notes inventory entries that no longer reproduce, without failing', () => {
    const { flagged } = scan;

    const stale: string[] = [];
    for (const [key, expected] of Object.entries(KNOWN_DROPPED_STATUS_LEAVES)) {
      const actual = flagged[key] ?? {};
      for (const path of Object.keys(expected)) {
        if (!(path in actual)) stale.push(`${key} :: ${path}`);
      }
    }

    if (stale.length > 0) {
      console.warn(
        `${stale.length} inventoried status leaf/leaves now project cleanly. Delete them from ` +
          `KNOWN_DROPPED_STATUS_LEAVES in this file (and the composition's key, if it is now ` +
          `empty):\n${stale.sort().map((entry) => `  - ${entry}`).join('\n')}`
      );
    }

    // Deliberately not an assertion: shrinking is the goal, never a failure.
    expect(Array.isArray(stale)).toBe(true);
  });

  it('records every composition that cannot be scanned in KRO mode', () => {
    const { unscannable } = scan;

    expect(Object.keys(unscannable).sort()).toEqual(Object.keys(NOT_KRO_SERIALIZABLE).sort());
  });

  it('scans a meaningful number of compositions', () => {
    // Guards the walk itself: an import path change that silently found
    // nothing would otherwise pass every assertion above.
    const { moduleCount, flagged } = scan;
    expect(moduleCount).toBeGreaterThan(15);
    expect(Object.keys(flagged).length).toBeGreaterThan(0);
  });

  it('pins the inventory in sorted order, so a diff reads as one field', () => {
    const keys = Object.keys(KNOWN_DROPPED_STATUS_LEAVES);
    expect(keys).toEqual([...keys].sort());
    for (const [key, leaves] of Object.entries(KNOWN_DROPPED_STATUS_LEAVES)) {
      const paths = Object.keys(leaves);
      expect({ [key]: paths }).toEqual({ [key]: [...paths].sort() });
    }
  });
});
