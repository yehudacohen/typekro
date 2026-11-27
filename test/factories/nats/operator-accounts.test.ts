import { describe, expect, it } from 'bun:test';
import { decode, parseCreds } from '@nats-io/jwt';
import { load } from 'js-yaml';
import {
  generateNatsSeed,
  issueNatsOperatorAccounts,
  type NatsOperatorAccountsConfig,
  NatsOperatorAccountsError,
} from '../../../src/factories/nats/auth/operator-accounts.js';
import {
  makeNatsBootstrap,
  NATS_OPERATOR_CONFIG_FILE,
  natsBootstrap,
} from '../../../src/factories/nats/compositions/nats-bootstrap.js';

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
          {
            name: 'api',
            seed: API_SEED,
            subjectPrefix: 'orders.api',
            jetStream: false,
            responses: true,
            inboxPrefix: '_INBOX_orders_api',
          },
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
    expect(ordersClaims.nats.limits).toMatchObject({
      disk_storage: 2 * 1024 ** 3,
      mem_storage: 256 * 1024 ** 2,
      streams: 32,
      consumer: 256,
      conn: 128,
      leaf: 0,
      disallow_bearer: true,
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
    expect(worker?.inboxPrefix).toBe(`_INBOX.${worker?.publicKey}`);
    expect(workerClaims.nats.pub).toEqual({
      allow: ['orders', 'orders.>'],
      deny: [],
    });
    expect(workerClaims.nats.sub).toEqual({
      allow: ['orders', 'orders.>', `${worker?.inboxPrefix}.>`],
      deny: [],
    });
    expect(workerClaims.nats).not.toHaveProperty('resp');
    expect(workerClaims.nats.bearer_token).toBe(false);
    const apiClaims = claims(api?.jwt ?? '');
    expect(api?.inboxPrefix).toBe('_INBOX_orders_api');
    expect(apiClaims.nats.pub).toEqual({ allow: ['orders.api', 'orders.api.>'], deny: [] });
    expect(apiClaims.nats.sub).toEqual({
      allow: ['orders.api', 'orders.api.>', '_INBOX_orders_api.>'],
      deny: [],
    });
    expect(apiClaims.nats.resp).toEqual({ max: 1, ttl: 0 });

    const creds = await parseCreds(new TextEncoder().encode(worker?.creds ?? ''));
    expect(creds.jwt).toBe(worker?.jwt ?? '');
    expect(creds.key).toBe(WORKER_SEED);
    expect(creds.aid).toBe(orders?.publicKey ?? '');
  });

  it('supports explicit account-wide access, shared inboxes and stream-scoped access', async () => {
    const [orders] = config().accounts;
    if (!orders) throw new Error('fixture');
    const issued = await issueNatsOperatorAccounts(
      config({
        accounts: [
          {
            ...orders,
            users: [
              { name: 'manager', seed: WORKER_SEED, jetStream: true, inboxPrefix: '_INBOX' },
              { name: 'consumer', seed: API_SEED, jetStream: { streams: ['ORDERS', 'AUDIT_LOG'] } },
            ],
          },
        ],
      })
    );
    const [manager, consumer] = issued.accounts[0]?.users ?? [];
    expect(manager?.inboxPrefix).toBe('_INBOX');
    expect(claims(manager?.jwt ?? '').nats).toMatchObject({
      pub: { allow: ['orders', 'orders.>', '$JS.API.>', '$JS.ACK.>', '$JS.FC.>'] },
      sub: { allow: ['orders', 'orders.>', '_INBOX.>'] },
    });
    const scoped = decode<{ pub: { allow: string[] }; sub: { allow: string[] } }>(
      consumer?.jwt ?? ''
    ).nats;
    if (!scoped.pub || !scoped.sub) throw new Error('Expected scoped publish and subscribe claims');
    expect(scoped.pub.allow).toEqual(
      expect.arrayContaining([
        '$JS.API.INFO',
        '$JS.API.STREAM.INFO.ORDERS',
        '$JS.API.CONSUMER.CREATE.ORDERS.>',
        '$JS.API.CONSUMER.MSG.NEXT.AUDIT_LOG.*',
        '$JS.ACK.AUDIT_LOG.*.*.*.*.*.*',
      ])
    );
    expect(scoped.pub.allow).not.toContain('$JS.API.>');
    expect(scoped.pub.allow).not.toContain('$JS.API.STREAM.LIST');
    expect(scoped.pub.allow).not.toContain('$JS.ACK.>');
    expect(scoped.sub.allow).toEqual(['orders', 'orders.>', `${consumer?.inboxPrefix}.>`]);
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
        /quantity such as "2Gi"/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, streams: 1.5 } }] },
        /limits\.streams/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, connections: -2 } }] },
        /limits\.connections/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, streams: 0 } }] },
        /reads 0 as unlimited.*limits\.streams/,
      ],
      [
        { accounts: [{ ...orders, limits: { ...orders.limits, consumers: 0 } }] },
        /limits\.consumers/,
      ],
      [
        {
          accounts: [
            { ...orders, users: [{ name: 'w', seed: WORKER_SEED, inboxPrefix: '_INBOX.>' }] },
          ],
        },
        /inboxPrefix/,
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

  it('rejects empty scopes and stream names that are not literal JetStream names', async () => {
    const [orders] = config().accounts;
    if (!orders) throw new Error('fixture');
    for (const streams of [[], ['*'], ['>'], ['ORDERS.*'], ['ORDERS.OTHER'], ['path/ORDERS']]) {
      await expect(
        issueNatsOperatorAccounts(
          config({
            accounts: [
              { ...orders, users: [{ name: 'w', seed: WORKER_SEED, jetStream: { streams } }] },
            ],
          })
        )
      ).rejects.toThrow(/jetStream\.streams/);
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
      podTemplate: unknown;
    };
    expect(values.config.merge).toEqual({ '00$include': NATS_OPERATOR_CONFIG_FILE });
    expect(values.config.jetstream.enabled).toBe(true);
    expect(values.configMap.merge.data[NATS_OPERATOR_CONFIG_FILE]).toBe(issued.serverConfig);
    // nats-server cannot reload into operator mode: a changed config rolls the pods.
    expect(values.podTemplate).toEqual({ configChecksumAnnotation: true });

    const open = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
    });
    expect(open).not.toContain('$include');
    expect(open).not.toContain('configMap');
    expect(open).not.toContain('configChecksumAnnotation');

    expect(() =>
      natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'nats',
        namespace: 'nats-system',
        operatorConfig: `${issued.serverConfig}\n# ${ORDERS_SEED}\n`,
      })
    ).toThrow(/must not contain an nkey seed/);
  });

  it('supports existing credential Secrets for the NACK controller and NATS toolbox', async () => {
    const issued = await issueNatsOperatorAccounts(config());
    const controllerValues = {
      additionalVolumes: [{ name: 'orders-creds', secret: { secretName: 'orders-nack-creds' } }],
      additionalVolumeMounts: [
        { name: 'orders-creds', mountPath: '/etc/nats/orders', readOnly: true },
      ],
    };
    const toolbox = {
      contexts: {
        default: { creds: { secretName: 'orders-toolbox-creds', key: 'nats.creds' } },
      },
    };
    const declarations = await makeNatsBootstrap({ controller: { values: controllerValues } })
      .factory('direct', { namespace: 'typekro-system' })
      .toAlchemyResources({
        name: 'nats',
        namespace: 'nats-system',
        operatorConfig: issued.serverConfig,
        values: { natsBox: toolbox },
      });
    const controller = declarations.find(
      (declaration) => declaration.props.resourceId === 'nackHelmRelease'
    );
    expect(controller?.props.resource.spec?.values).toMatchObject({
      ...controllerValues,
      jetstream: { controlLoop: true },
    });
    expect(controller?.props.resource.spec?.values).not.toHaveProperty('jetstream.nats');
    const server = declarations.find(
      (declaration) => declaration.props.resourceId === 'natsHelmRelease'
    );
    expect(server?.props.resource.spec?.values).toMatchObject({
      natsBox: { enabled: true, ...toolbox },
      configMap: { merge: { data: { [NATS_OPERATOR_CONFIG_FILE]: issued.serverConfig } } },
    });
  });

  it('serializes operator mode as a KRO instance field', async () => {
    const factory = natsBootstrap.factory('kro', { namespace: 'typekro-system' });
    const rgd = factory.toYaml();
    expect(rgd).toContain(
      'operatorConfig: string | maxLength=524288 validation="!self.matches(\\"S[OAU][A-Z2-7]{56}\\")"'
    );
    // Both chart keys are omitted when the instance has no operatorConfig.
    expect(rgd).toContain(
      `"00$include": (has(schema.spec.operatorConfig) ? dyn("${NATS_OPERATOR_CONFIG_FILE}") : omit())`
    );
    expect(rgd).toContain(
      `"${NATS_OPERATOR_CONFIG_FILE}": (has(schema.spec.operatorConfig) ? dyn(schema.spec.operatorConfig) : omit())`
    );
    expect(rgd).toContain(
      '"configChecksumAnnotation": (has(schema.spec.operatorConfig) ? dyn(true) : omit())'
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
