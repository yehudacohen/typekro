import { type } from 'arktype';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import { REQUIRED_FIELD_SENTINEL } from '../../../src/core/serialization/schema.js';
import {
  CHI_STATUS,
  clickHouseInstallation,
  DEFAULT_CHI_CLUSTER_NAME,
} from '../../../src/factories/clickhouse/resources/installation.js';
import {
  clickHouseKeeperInstallation,
  DEFAULT_CHK_CLUSTER_NAME,
} from '../../../src/factories/clickhouse/resources/keeper.js';

/**
 * The keeper factory holds a module-private component logger. Every logger
 * shares one prototype, so spying there intercepts its `warn` without exporting
 * the instance for tests (same approach as the nested-status-inliner suite).
 */
function spyOnLoggerWarn() {
  const loggerPrototype = Object.getPrototypeOf(getComponentLogger('keeper-factory-test')) as {
    warn: (message: string, metadata?: Record<string, unknown>) => void;
  };
  return spyOn(loggerPrototype, 'warn');
}

/**
 * The Altinity CRD's own cap on `spec.configuration.clusters[].name`
 * (`maxLength: 15`, `See namePartClusterMaxLen const`) — identical on the CHI
 * and the CHK, while `metadata.name` is uncapped on both.
 */
const CLUSTER_NAME_MAX_BYTES = 15;

describe('ClickHouseKeeperInstallation Factory', () => {
  describe('resource creation', () => {
    it('should create a CHK resource with minimal config', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(chk).toBeDefined();
      expect(chk.kind).toBe('ClickHouseKeeperInstallation');
      expect(chk.apiVersion).toBe('clickhouse-keeper.altinity.com/v1');
      expect(chk.metadata.name).toBe('keeper');
      // The cluster name derives from the installation name, which fits the
      // 15-byte cap here.
      expect(chk.spec.configuration?.clusters?.[0]).toEqual({
        name: 'keeper',
        layout: { replicasCount: 1 },
      });
    });

    it('should create a namespaced resource with explicit replicas', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'keeper',
        namespace: 'observability',
        replicas: 3,
      });

      expect(chk.metadata.namespace).toBe('observability');
      expect(chk.spec.configuration?.clusters?.[0]?.layout?.replicasCount).toBe(3);
    });

    it.each([0, -3, 1.5])('rejects invalid keeper replicas %p', (replicas) => {
      expect(() => clickHouseKeeperInstallation({ name: 'keeper', replicas })).toThrow(
        /clickHouseKeeperInstallation: 'replicas' must be a positive integer/
      );
    });

    it('should omit storage templates when no storage is configured', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      // The Enhanced proxy materializes accessed fields, so absence is
      // asserted via the spec's own keys rather than `toBeUndefined()`.
      expect(Object.keys(chk.spec)).not.toContain('templates');
      expect(Object.keys(chk.spec)).not.toContain('defaults');
    });

    it('should emit a data volume claim when storage is configured', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'keeper',
        replicas: 3,
        storage: { size: '10Gi', storageClassName: 'gp3-expandable' },
      });

      expect(chk.spec.defaults?.templates?.dataVolumeClaimTemplate).toBe('data-volume');
      expect(chk.spec.templates?.volumeClaimTemplates?.[0]).toEqual({
        name: 'data-volume',
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '10Gi' } },
          storageClassName: 'gp3-expandable',
        },
      });
    });

    it('should accept an id for composition references', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper', id: 'chKeeper' });
      expect(chk).toBeDefined();
    });
  });

  /**
   * LIVE FAILURE THIS COVERS. The CHK copies the installation name into
   * `spec.configuration.clusters[0].name`. The CRD caps that field at 15 bytes
   * (`minLength: 1`, `maxLength: 15`, `^[a-zA-Z0-9-]{0,15}$`) while
   * `metadata.name` is uncapped, so the first apply of any keeper with a longer
   * release name was rejected by the API server:
   *
   *   ClickHouseKeeperInstallation … is invalid:
   *   spec.configuration.clusters[0].name: Too long: may not be more than 15 bytes
   *
   * THE DERIVATION IS KEPT, deliberately. The cluster name is a fragment of
   * every generated object name, so switching it on an existing deployment
   * replaces the StatefulSet with fresh volumes and loses the keeper's
   * coordination state. Every deployment that already worked had a name within
   * the cap, so it keeps exactly the names it had; only the names that could
   * never have worked change — from an operator rejection into a BUILD error
   * that asks for an explicit `clusterName`.
   */
  describe('cluster name (Altinity 15-byte cap)', () => {
    it('defaults to the installation name when it fits the cap (unchanged behaviour)', () => {
      for (const name of ['keeper', 'ch-keeper', 'abcdefghijklmno']) {
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(CLUSTER_NAME_MAX_BYTES);
        expect(clickHouseKeeperInstallation({ name }).spec.configuration?.clusters?.[0]?.name).toBe(
          name
        );
      }
    });

    it('fails at BUILD time when the installation name cannot be a cluster name', () => {
      // The exact shape of the live failure: a 24-byte release name.
      const installationName = 'observability-clickstack';
      expect(Buffer.byteLength(installationName, 'utf8')).toBeGreaterThan(CLUSTER_NAME_MAX_BYTES);

      expect(() => clickHouseKeeperInstallation({ name: installationName, replicas: 3 })).toThrow(
        /clickHouseKeeperInstallation: 'clusterName' defaults to the installation name/
      );
    });

    it('names the field, the length, the cap and the remedy in the error', () => {
      let message = '';
      try {
        clickHouseKeeperInstallation({ name: 'observability-clickstack' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain("'clusterName'");
      expect(message).toContain('"observability-clickstack"');
      expect(message).toContain('24 bytes');
      expect(message).toContain(`the cap is ${CLUSTER_NAME_MAX_BYTES}`);
      expect(message).toContain(`clusterName: '${DEFAULT_CHK_CLUSTER_NAME}'`);
      // No silent truncation and no silent rename: the message says the value
      // is a fragment of the generated object names and must be picked once.
      expect(message).toContain('loses keeper coordination');
    });

    it('accepts the over-long installation name once clusterName is explicit', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'observability-clickstack',
        clusterName: DEFAULT_CHK_CLUSTER_NAME,
        replicas: 3,
      });

      expect(chk.metadata.name).toBe('observability-clickstack');
      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe(DEFAULT_CHK_CLUSTER_NAME);
      expect(Buffer.byteLength(DEFAULT_CHK_CLUSTER_NAME, 'utf8')).toBeLessThanOrEqual(
        CLUSTER_NAME_MAX_BYTES
      );
    });

    it('honours any other explicit clusterName override', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'observability-clickstack',
        clusterName: 'coordination',
      });

      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe('coordination');
    });

    it('rejects an installation name that is legal for an object but not for a cluster', () => {
      // Within the cap, but the CRD pattern forbids the dot.
      expect(() => clickHouseKeeperInstallation({ name: 'keeper.prod' })).toThrow(/does not match/);
    });

    it('accepts a cluster name AT the 15-byte cap', () => {
      const atCap = 'abcdefghijklmno';
      expect(Buffer.byteLength(atCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES);

      const chk = clickHouseKeeperInstallation({ name: 'keeper', clusterName: atCap });

      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe(atCap);
    });

    it('rejects a cluster name ONE byte past the cap, at build time', () => {
      const pastCap = 'abcdefghijklmnop';
      expect(Buffer.byteLength(pastCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES + 1);

      expect(() => clickHouseKeeperInstallation({ name: 'keeper', clusterName: pastCap })).toThrow(
        /clickHouseKeeperInstallation: 'clusterName' must match/
      );
    });

    it('shares the 15-byte boundary with the CHI', () => {
      const atCap = 'abcdefghijklmno';
      const pastCap = 'abcdefghijklmnop';
      const chiConfig = { name: 'observability-clickstack', version: '25.12.5' as const };
      const storage = { size: '10Gi' };

      // The CHI's default is its own constant and is unaffected by an
      // over-long installation name; only the CHK derives from `name`.
      expect(
        clickHouseInstallation({ ...chiConfig, storage }).spec.configuration?.clusters?.[0]?.name
      ).toBe(DEFAULT_CHI_CLUSTER_NAME);

      // Both accept an override at the cap and reject one byte past it.
      expect(() =>
        clickHouseInstallation({ ...chiConfig, storage, clusterName: atCap })
      ).not.toThrow();
      expect(() =>
        clickHouseKeeperInstallation({ name: chiConfig.name, clusterName: atCap })
      ).not.toThrow();
      expect(() => clickHouseInstallation({ ...chiConfig, storage, clusterName: pastCap })).toThrow(
        /'clusterName' must match/
      );
      expect(() =>
        clickHouseKeeperInstallation({ name: chiConfig.name, clusterName: pastCap })
      ).toThrow(/'clusterName' must match/);
    });

    it.each([
      ['space', 'my cluster'],
      ['underscore (the CRD pattern forbids it)', 'my_cluster'],
      ['dot', 'keeper.prod'],
      ['empty (the CRD sets minLength 1)', ''],
    ])('rejects a keeper cluster name with a %s', (_label, clusterName) => {
      expect(() => clickHouseKeeperInstallation({ name: 'keeper', clusterName })).toThrow(
        /clickHouseKeeperInstallation: 'clusterName' must match/
      );
    });

    it.each([
      // The keeper's rule is Altinity's contract EXACTLY: one to 15 letters,
      // digits or dashes, in any order. Nothing is added to it.
      ['a trailing dash', 'keeper-'],
      ['a leading digit', '9keeper'],
      ['a leading dash', '-keeper'],
      ['only digits', '2024'],
      ['interior digits', 'keeper9'],
      ['interior dashes', 'a-b-c-d'],
    ])('accepts a keeper cluster name with %s', (_label, clusterName) => {
      expect(
        clickHouseKeeperInstallation({ name: 'keeper', clusterName }).spec.configuration
          ?.clusters?.[0]?.name
      ).toBe(clusterName);
    });

    it.each([
      ['a trailing dash', 'keeper-'],
      ['a leading digit', '9keeper'],
    ])('accepts %s in the INSTALLATION name, deriving the cluster name from it', (_l, name) => {
      expect(clickHouseKeeperInstallation({ name }).spec.configuration?.clusters?.[0]?.name).toBe(
        name
      );
    });

    /**
     * THE CHI AND THE CHK DO NOT SHARE A RULE, and the difference is
     * load-bearing rather than an oversight.
     *
     * The CHI generator renders the cluster name as a RAW XML ELEMENT NAME
     * (`util.Iline(b, indent, "<%s>", cluster.GetName())` in
     * `pkg/model/chi/config/generator.go`), so `<9cluster>` would be an
     * unparseable `remote_servers.xml`. The keeper's generator emits
     * `<server><id>/<hostname>/<port>` built from HOST names
     * (`pkg/model/chk/config/generator.go`, `getRaftConfig`) and never uses the
     * cluster name as an element name; the value reaches only the sanitized
     * macro that feeds generated StatefulSet / Service / ConfigMap names, where
     * a leading digit is a fine DNS-1123 label. `9keeper` was valid upstream,
     * so it stays valid here.
     */
    describe('CHI vs CHK: only the CHI adds the leading-letter rule', () => {
      const chi = (clusterName: string) => () =>
        clickHouseInstallation({
          name: 'ch',
          version: '25.12.5',
          storage: { size: '10Gi' },
          clusterName,
        });
      const chk = (clusterName: string) => () =>
        clickHouseKeeperInstallation({ name: 'keeper', clusterName });

      it('accepts a leading digit for the CHK and rejects it for the CHI', () => {
        expect(chk('9keeper')).not.toThrow();
        expect(chi('9cluster')).toThrow(/clickHouseInstallation: 'clusterName' must match/);
      });

      it('accepts a trailing dash for BOTH', () => {
        expect(chk('keeper-')).not.toThrow();
        expect(chi('cluster-')).not.toThrow();
      });

      it('rejects 16 bytes for BOTH, and accepts 15 for both', () => {
        const atCap = 'abcdefghijklmno';
        const pastCap = 'abcdefghijklmnop';
        expect(Buffer.byteLength(atCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES);
        expect(Buffer.byteLength(pastCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES + 1);

        expect(chk(atCap)).not.toThrow();
        expect(chi(atCap)).not.toThrow();
        expect(chk(pastCap)).toThrow(/'clusterName' must match/);
        expect(chi(pastCap)).toThrow(/'clusterName' must match/);
      });

      it('explains in each error why the rule is what it is', () => {
        let chiMessage = '';
        try {
          chi('9cluster')();
        } catch (error) {
          chiMessage = (error as Error).message;
        }
        expect(chiMessage).toContain('XML ELEMENT NAME');
        expect(chiMessage).toContain('remote_servers.xml');
        expect(chiMessage).toContain('A trailing dash is fine.');

        let chkMessage = '';
        try {
          chk('my_keeper')();
        } catch (error) {
          chkMessage = (error as Error).message;
        }
        expect(chkMessage).toContain("the Altinity CRD's own rule");
        expect(chkMessage).toContain('never uses the value as an XML element name');
      });
    });
  });

  /**
   * THE ONE CASE A BUILD CHECK CANNOT COVER. In kro mode `name` is a schema
   * reference, so the rendered RGD carries
   * `clusters[0].name: ${schema.spec.name}` and the value is only known when an
   * instance is created. The generated KRO schema types `spec.name` as a bare
   * `string` with no length bound, so an over-long instance name still reaches
   * the operator. The factory therefore WARNS at build time instead of
   * throwing — requiring `clusterName` for references would force it on
   * existing KRO-mode deployments, where changing it loses keeper state.
   */
  describe('kro mode (reference name)', () => {
    let warnSpy: ReturnType<typeof spyOnLoggerWarn>;

    beforeEach(() => {
      warnSpy = spyOnLoggerWarn();
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** Warnings this factory emitted, message only. */
    function keeperWarnings(): string[] {
      return warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.startsWith('clickHouseKeeperInstallation:'));
    }

    function renderKeeperComposition(id: string, namespace: string, clusterName?: string): string {
      const composition = kubernetesComposition(
        {
          name: `chk-${id}`,
          apiVersion: 'test.typekro.dev/v1',
          kind: `ChkRef${id}`,
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec: { name: string }) => {
          const chk = clickHouseKeeperInstallation({
            name: spec.name,
            namespace,
            replicas: 3,
            ...(clusterName !== undefined ? { clusterName } : {}),
            id: 'chKeeper',
          });
          return { ready: true as unknown as boolean, endpoint: chk.metadata.name } as never;
        }
      );
      return composition.toYaml();
    }

    it('emits the reference and warns once when clusterName is unset', () => {
      const yaml = renderKeeperComposition('Unset', 'chk-warn-unset');

      // The cluster name follows the instance name into the RGD.
      expect(yaml).toContain('kind: ClickHouseKeeperInstallation');
      expect(yaml).toMatch(/clusters:[\s\S]*?name: \$\{schema\.spec\.name\}/);

      // Exactly one warning, although the composition body re-executes several
      // times per serialization.
      const warnings = keeperWarnings();
      expect(warnings).toHaveLength(1);
      const [message] = warnings;
      expect(message).toContain("'name' is a schema reference");
      expect(message).toContain('follows the INSTANCE name at runtime');
      expect(message).toContain('15 bytes');
      expect(message).toContain(`clusterName: DEFAULT_CHK_CLUSTER_NAME ('keeper')`);
      // The state-loss caveat keeps an existing deployment from "fixing" it.
      expect(message).toContain('loses the coordination state');
      // And the way to make KRO validate at admission instead — the KEEPER's
      // schema, which is Altinity's contract exactly.
      expect(message).toContain('ClickHouseKeeperClusterNameSchema');
    });

    it('emits the pinned name and does NOT warn when clusterName is set', () => {
      const yaml = renderKeeperComposition('Pinned', 'chk-warn-pinned', DEFAULT_CHK_CLUSTER_NAME);

      expect(yaml).toContain('kind: ClickHouseKeeperInstallation');
      expect(yaml).toMatch(/clusters:[\s\S]*?name: keeper/);
      expect(yaml).not.toMatch(/clusters:[\s\S]*?name: \$\{schema\.spec\.name\}/);
      expect(keeperWarnings()).toHaveLength(0);
    });

    /**
     * THE DEDUPE IS BUILD-SCOPED, NOT PROCESS-GLOBAL. Collapsing the repeats
     * with a module-level set keyed on `namespace|id` would have silenced a
     * genuine warning for any composition built later in the same process with
     * the same namespace and id — and two keepers in one namespace with no
     * explicit `id` would have shared a key. The gate is the framework's own
     * `suppressResourceDiagnostics`, which marks the internal analysis passes,
     * so nothing is remembered between builds.
     */
    it('warns again for an INDEPENDENT composition with the same namespace and id', () => {
      renderKeeperComposition('First', 'chk-shared-ns');
      expect(keeperWarnings()).toHaveLength(1);

      // A brand-new composition, same namespace, same resource id.
      renderKeeperComposition('Second', 'chk-shared-ns');
      expect(keeperWarnings()).toHaveLength(2);
    });

    /**
     * The un-`id`ed collision the old key could have produced cannot actually
     * arise for a reference name: the composition machinery refuses to generate
     * a deterministic resource ID for a `KubernetesRef` name and demands an
     * explicit `id` first. Two keepers in one namespace therefore always differ
     * by id — and each still gets its own warning.
     */
    it('warns for EACH keeper in one composition', () => {
      const composition = kubernetesComposition(
        {
          name: 'chk-pair',
          apiVersion: 'test.typekro.dev/v1',
          kind: 'ChkRefPair',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec: { name: string }) => {
          const a = clickHouseKeeperInstallation({
            name: spec.name,
            namespace: 'chk-pair-ns',
            id: 'keeperA',
          });
          const b = clickHouseKeeperInstallation({
            name: `${spec.name}-b`,
            namespace: 'chk-pair-ns',
            id: 'keeperB',
          });
          return {
            ready: true as unknown as boolean,
            a: a.metadata.name,
            b: b.metadata.name,
          } as never;
        }
      );
      composition.toYaml();

      expect(keeperWarnings()).toHaveLength(2);
    });

    it('never validates a TEMPLATE-LITERAL name as a real installation name', () => {
      // `${spec.name}-b` stringifies to a plain string carrying the schema
      // proxy's `__KUBERNETES_REF_...__` marker, which the serializer rewrites
      // to CEL later. Validating it would throw on a valid kro-mode build.
      expect(() =>
        clickHouseKeeperInstallation({
          name: '__KUBERNETES_REF___schema___spec.name__-b',
          namespace: 'chk-template-literal',
          // A dynamic name needs an explicit id — the composition machinery
          // cannot derive a deterministic resource ID from one.
          id: 'chKeeperTemplate',
        })
      ).not.toThrow();
    });

    it('never validates the required-field sentinel as a real installation name', () => {
      // The defaults-extraction pass substitutes `__typekro_default__` for a
      // required spec field. It contains underscores and is past the cap, so
      // validating it would throw on a perfectly valid kro-mode build.
      expect(() => renderKeeperComposition('Sentinel', 'chk-warn-sentinel')).not.toThrow();
      expect(() =>
        clickHouseKeeperInstallation({ name: REQUIRED_FIELD_SENTINEL, namespace: 'chk-sentinel' })
      ).not.toThrow();
    });
  });

  describe('readiness evaluation', () => {
    it('should share the CHI status-state readiness semantics', () => {
      // CHK reports the same status.status state machine as CHI
      // (shared operator status code).
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(chk.readinessEvaluator).toBeDefined();
      expect(
        chk.readinessEvaluator?.({ status: { status: CHI_STATUS.COMPLETED } })?.ready
      ).toBe(true);
      expect(
        chk.readinessEvaluator?.({ status: { status: CHI_STATUS.IN_PROGRESS } })?.ready
      ).toBe(false);
      expect(chk.readinessEvaluator?.(null)?.reason).toBe('StatusMissing');
    });
  });
});
