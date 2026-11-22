import { describe, expect, it } from 'bun:test';
import { decode, parseCreds } from '@nats-io/jwt';
import { load } from 'js-yaml';
import {
  NATS_OPERATOR_CONFIG_FILE,
  natsBootstrap,
} from '../../../src/factories/nats/compositions/nats-bootstrap.js';
import {
  generateNatsSeed,
  issueNatsOperatorAccounts,
  type NatsOperatorAccountsConfig,
  NatsOperatorAccountsError,
} from '../../../src/factories/nats/auth/operator-accounts.js';

// Fixed test seeds generated once with @nats-io/nkeys. They protect nothing.
const OPERATOR_SEED = 'SOAEFSK7RMHC2MPIFD4R2STR27TY75XOJKVEKTLVVZI4U5DZ56KDMJKTTQ';
const SYSTEM_SEED = 'SAAMXMHMYEXQQEDSNXJIOW2PBRF44ZWUWFPEGJOVL4EHREF23LFZFUAVGM';
const ORDERS_SEED = 'SAAEUCBVSPQFV64BO3MPZAR5HERQMLNDSMXTEUWUVW72L7IRVIZZ6ZSIIU';
const BILLING_SEED = 'SAANLHFW73L57KP2XIQ23FHLJURYDI57V7YYYQHAII2PTVU7PT3EQRT5KQ';
const WORKER_SEED = 'SUAG3ZNPMD5HPQGF27XPWYWE7OSPDFMYFZDZXHBTSU3IE4BGXB44X6UG2M';
const API_SEED = 'SUAPDNYOCJYMMRIVTO7YXIO64ERZZUPBWOXUGKIYSS2P2YLEDCUP2KMVNA';

const ISSUED_AT = 1_790_000_000;

function config(overrides: Partial<NatsOperatorAccountsConfig> = {}): NatsOperatorAccountsConfig {
  return {
    operator: { name: 'platform', seed: OPERATOR_SEED },
    systemAccount: { seed: SYSTEM_SEED },
    accounts: [
      {
        name: 'orders',
        seed: ORDERS_SEED,
        subjectPrefix: 'orders',
        limits: {
          fileStorage: '2Gi',
          memoryStorage: '256Mi',
          streams: 32,
          consumers: 256,
          connections: 128,
        },
        users: [
          { name: 'worker', seed: WORKER_SEED },
          { name: 'api', seed: API_SEED, subjectPrefix: 'orders.api', jetStream: false },
        ],
      },
      {
        name: 'billing',
        seed: BILLING_SEED,
        subjectPrefix: 'billing',
        limits: { fileStorage: 0, memoryStorage: 0, streams: 0, consumers: 0, connections: 8 },
      },
    ],
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

interface Claims {
  iss: string;
  sub: string;
  iat: number;
  name: string;
  nats: Record<string, unknown>;
}

const claims = (jwt: string) => decode<Record<string, unknown>>(jwt) as unknown as Claims;

describe('NATS operator accounts', () => {
  it('issues a verifiable operator -> account -> user chain', async () => {
    const issued = await issueNatsOperatorAccounts(config());

    // decode() verifies each signature against its issuer.
    const operator = claims(issued.operator.jwt);
    expect(operator.sub).toBe(issued.operator.publicKey);
    expect(operator.iss).toBe(issued.operator.publicKey);
    expect(operator.nats.system_account).toBe(issued.systemAccount.publicKey);
    expect(operator.nats.type).toBe('operator');

    const system = claims(issued.systemAccount.jwt);
    expect(system.name).toBe('SYS');
    expect(system.iss).toBe(issued.operator.publicKey);
    expect(system.nats.limits).not.toHaveProperty('disk_storage');

    const [orders, billing] = issued.accounts;
    const ordersClaims = claims(orders?.jwt ?? '');
    expect(ordersClaims.iss).toBe(issued.operator.publicKey);
    expect(ordersClaims.sub).toBe(orders?.publicKey ?? '');
    expect(ordersClaims.nats.disallow_bearer).toBe(true);
    expect(ordersClaims.nats.limits).toMatchObject({
      disk_storage: 2 * 1024 ** 3,
      mem_storage: 256 * 1024 ** 2,
      streams: 32,
      consumer: 256,
      conn: 128,
      leaf: 0,
    });
    expect(claims(billing?.jwt ?? '').nats.limits).toMatchObject({
      disk_storage: 0,
      mem_storage: 0,
      streams: 0,
      consumer: 0,
      conn: 8,
    });

    const [worker, api] = orders?.users ?? [];
    const workerClaims = claims(worker?.jwt ?? '');
    expect(workerClaims.iss).toBe(orders?.publicKey ?? '');
    expect(workerClaims.nats.pub).toEqual({
      allow: ['orders.>', '$JS.API.>', '$JS.ACK.>'],
      deny: [],
    });
    expect(workerClaims.nats.sub).toEqual({ allow: ['orders.>', '_INBOX.>'], deny: [] });
    expect(workerClaims.nats.resp).toEqual({ max: 1, ttl: 0 });
    expect(workerClaims.nats.bearer_token).toBe(false);
    expect(claims(api?.jwt ?? '').nats.pub).toEqual({ allow: ['orders.api.>'], deny: [] });

    const creds = await parseCreds(new TextEncoder().encode(worker?.creds ?? ''));
    expect(creds.jwt).toBe(worker?.jwt ?? '');
    expect(creds.key).toBe(WORKER_SEED);
    expect(creds.aid).toBe(orders?.publicKey ?? '');
  });

  it('reissues byte-identical output from the same seeds and issue time', async () => {
    const first = await issueNatsOperatorAccounts(config());
    const second = await issueNatsOperatorAccounts(
      config({ issuedAt: new Date(ISSUED_AT * 1000) })
    );
    expect(second).toEqual(first);
    expect(claims(first.operator.jwt).iat).toBe(ISSUED_AT);

    const later = await issueNatsOperatorAccounts(config({ issuedAt: ISSUED_AT + 1 }));
    expect(later.operator.publicKey).toBe(first.operator.publicKey);
    expect(later.operator.jwt).not.toBe(first.operator.jwt);
    // The real clock is untouched after issuing.
    expect(Date.now()).toBeGreaterThan(ISSUED_AT * 1000 + 1000);
  });

  it('renders a memory-resolver server configuration with no seeds', async () => {
    const issued = await issueNatsOperatorAccounts(config());
    expect(Object.keys(issued.resolverPreload)).toEqual([
      issued.systemAccount.publicKey,
      ...issued.accounts.map(({ publicKey }) => publicKey),
    ]);
    expect(issued.serverConfig).toContain(`operator: "${issued.operator.jwt}"`);
    expect(issued.serverConfig).toContain(`system_account: "${issued.systemAccount.publicKey}"`);
    expect(issued.serverConfig).toContain('resolver: MEMORY');
    for (const account of issued.accounts) {
      expect(issued.serverConfig).toContain(`  ${account.publicKey}: "${account.jwt}"`);
    }
    for (const seed of [OPERATOR_SEED, SYSTEM_SEED, ORDERS_SEED, BILLING_SEED, WORKER_SEED]) {
      expect(issued.serverConfig).not.toContain(seed);
    }
  });

  it('generates seeds of each kind', () => {
    expect(generateNatsSeed('operator')).toMatch(/^SO[A-Z2-7]{56}$/);
    expect(generateNatsSeed('account')).toMatch(/^SA[A-Z2-7]{56}$/);
    expect(generateNatsSeed('user')).toMatch(/^SU[A-Z2-7]{56}$/);
    expect(generateNatsSeed('account')).not.toBe(generateNatsSeed('account'));
  });

  it('refuses invalid configuration without echoing seeds', async () => {
    const [orders] = config().accounts;
    if (!orders) throw new Error('fixture');
    const cases: [Partial<NatsOperatorAccountsConfig>, RegExp][] = [
      [
        { operator: { name: 'platform', seed: ORDERS_SEED } },
        /operator nkey seed .* operator\.seed/,
      ],
      [{ systemAccount: { seed: OPERATOR_SEED } }, /account nkey seed .* systemAccount\.seed/],
      [{ accounts: [{ ...orders, seed: SYSTEM_SEED }] }, /used by another account/],
      [{ accounts: [orders, { ...orders, seed: BILLING_SEED }] }, /"orders" is used twice/],
      [{ accounts: [{ ...orders, name: 'SYS' }] }, /"SYS" is used twice/],
      [{ accounts: [{ ...orders, subjectPrefix: 'orders.>' }] }, /no spaces or wildcards/],
      [{ accounts: [{ ...orders, subjectPrefix: '$JS' }] }, /reserved/],
      [{ accounts: [{ ...orders, subjectPrefix: 'orders..x' }] }, /no spaces or wildcards/],
      [
        {
          accounts: [
            { ...orders, users: [{ name: 'w', seed: WORKER_SEED, subjectPrefix: 'billing' }] },
          ],
        },
        /outside the account prefix/,
      ],
      [
        {
          accounts: [
            { ...orders, users: [{ name: 'w', seed: WORKER_SEED, subjectPrefix: 'ordersx' }] },
          ],
        },
        /outside the account prefix/,
      ],
      [{ accounts: [{ ...orders, users: [{ name: 'w', seed: ORDERS_SEED }] }] }, /user nkey seed/],
      [
        {
          accounts: [
            {
              ...orders,
              users: [
                { name: 'a', seed: WORKER_SEED },
                { name: 'b', seed: WORKER_SEED },
              ],
            },
          ],
        },
        /used by another user/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, fileStorage: '2GB' } }] },
        /binary quantity/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, streams: 1.5 } }] },
        /limits\.streams/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, connections: -2 } }] },
        /limits\.connections/,
      ],
      [{ issuedAt: -1 }, /issuedAt/],
      [{ issuedAt: new Date(Number.NaN) }, /issuedAt/],
      [{ operator: { name: ' platform', seed: OPERATOR_SEED } }, /operator\.name/],
    ];
    for (const [overrides, message] of cases) {
      const attempt = issueNatsOperatorAccounts(config(overrides));
      await expect(attempt).rejects.toBeInstanceOf(NatsOperatorAccountsError);
      await expect(attempt).rejects.toThrow(message);
      const error = await attempt.catch((caught: unknown) => caught);
      for (const seed of [OPERATOR_SEED, SYSTEM_SEED, ORDERS_SEED, WORKER_SEED]) {
        expect(String((error as Error).message)).not.toContain(seed);
      }
    }
  });

  it('turns on operator mode in the NATS installation from the issued configuration', async () => {
    const issued = await issueNatsOperatorAccounts(config());
    const yaml = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
      operatorConfig: issued.serverConfig,
    });
    const release = yaml
      .split(/^---$/m)
      .map((document) => load(document) as { kind?: string; spec?: { values?: unknown } } | null)
      .find((document) => document?.kind === 'HelmRelease');
    const values = release?.spec?.values as {
      config: { merge: Record<string, unknown>; jetstream: { enabled: boolean } };
      configMap: { merge: { data: Record<string, string> } };
    };
    expect(values.config.merge).toEqual({ '00$include': NATS_OPERATOR_CONFIG_FILE });
    expect(values.config.jetstream.enabled).toBe(true);
    expect(values.configMap.merge.data[NATS_OPERATOR_CONFIG_FILE]).toBe(issued.serverConfig);

    const open = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
    });
    expect(open).not.toContain('$include');
    expect(open).not.toContain('configMap');

    expect(() =>
      natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'nats',
        namespace: 'nats-system',
        operatorConfig: `${issued.serverConfig}\n# ${ORDERS_SEED}\n`,
      })
    ).toThrow(/must not contain an nkey seed/);
  });

  it('serializes operator mode as a KRO instance field', async () => {
    const factory = natsBootstrap.factory('kro', { namespace: 'typekro-system' });
    const rgd = factory.toYaml();
    expect(rgd).toContain(
      'operatorConfig: string | validation="!self.matches(\\"S[OAU][A-Z2-7]{56}\\")"'
    );
    // Both chart keys are omitted when the instance has no operatorConfig.
    expect(rgd).toContain(
      `"00$include": (has(schema.spec.operatorConfig) ? "${NATS_OPERATOR_CONFIG_FILE}" : omit())`
    );
    expect(rgd).toContain(
      `"${NATS_OPERATOR_CONFIG_FILE}": (has(schema.spec.operatorConfig) ? schema.spec.operatorConfig : omit())`
    );

    const issued = await issueNatsOperatorAccounts(config());
    const instance = factory.toYaml({
      name: 'nats',
      namespace: 'nats-system',
      operatorConfig: issued.serverConfig,
    });
    const document = instance
      .split(/^---$/m)
      .map((part) => load(part) as { kind?: string; spec: Record<string, unknown> } | null)
      .find((part) => part?.kind === 'NatsBootstrap');
    expect(document?.spec.operatorConfig).toBe(issued.serverConfig);
  });
});
