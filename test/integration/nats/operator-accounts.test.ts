import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  connect,
  credsAuthenticator,
  type NatsConnection,
  PermissionViolationError,
} from '@nats-io/transport-node';
import {
  generateNatsSeed,
  issueNatsOperatorAccounts,
  type NatsIssuedUser,
} from '../../../src/factories/nats/auth/operator-accounts.js';

const IMAGE = 'nats:2.14.0-alpine';

function dockerAvailable(): boolean {
  try {
    return (
      Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], {
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 5_000,
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env.REQUIRE_DOCKER_TESTS === 'true') {
  throw new Error('REQUIRE_DOCKER_TESTS=true but no Docker daemon is reachable');
}

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 10_000,
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`docker ${args[0]} failed`);
  return stdout.trim();
}

async function connectUser(directory: string, server: string, user: NatsIssuedUser) {
  const credsPath = join(directory, `${user.name}.creds`);
  await writeFile(credsPath, user.creds, { mode: 0o600 });
  const authenticator = credsAuthenticator(await readFile(credsPath));
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect({
        servers: server,
        authenticator,
        inboxPrefix: user.inboxPrefix,
        reconnect: false,
        timeout: 1_000,
      });
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(100);
    }
  }
}

async function expectDenied(
  connection: NatsConnection,
  operation: PermissionViolationError['operation'],
  subject: string,
  perform: () => void
) {
  const statuses = connection.status();
  const violation = (async () => {
    for await (const status of statuses) {
      if (status.type === 'error' && status.error instanceof PermissionViolationError) {
        return status.error;
      }
    }
    return undefined;
  })();
  perform();
  const error = await Promise.race([violation, delay(2_000, undefined, { ref: false })]);
  if (!error) throw new Error(`Expected NATS to reject ${operation} on ${subject}`);
  expect(error).toMatchObject({ operation, subject });
}

async function expectRequestDenied(connection: NatsConnection, subject: string) {
  await expect(connection.request(subject, '{}', { timeout: 2_000 })).rejects.toMatchObject({
    cause: { operation: 'publish', subject },
  });
}

describe.skipIf(!hasDocker)('NATS operator mode', () => {
  it('enforces user permissions on a real NATS server', async () => {
    await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).catch(() => {
      throw new Error(`The local ${IMAGE} image is required for this test`);
    });
    const issued = await issueNatsOperatorAccounts({
      operator: { name: 'operator', seed: generateNatsSeed('operator') },
      systemAccount: { seed: generateNatsSeed('account') },
      accounts: [
        {
          name: 'orders',
          seed: generateNatsSeed('account'),
          subjectPrefix: 'orders',
          limits: {
            fileStorage: '16Mi',
            memoryStorage: '16Mi',
            streams: 4,
            consumers: 4,
            connections: 8,
          },
          users: [
            { name: 'worker', seed: generateNatsSeed('user') },
            { name: 'responder', seed: generateNatsSeed('user'), responses: true },
            { name: 'scoped', seed: generateNatsSeed('user'), jetStream: { streams: ['ORDERS'] } },
            {
              name: 'admin',
              seed: generateNatsSeed('user'),
              jetStream: true,
              inboxPrefix: '_INBOX',
            },
          ],
        },
      ],
      issuedAt: Math.floor(Date.now() / 1_000),
    });
    const [workerUser, responderUser, scopedUser, adminUser] = issued.accounts[0]?.users ?? [];
    if (!workerUser || !responderUser || !scopedUser || !adminUser) {
      throw new Error('Expected four issued users');
    }

    const directory = await mkdtemp(join(tmpdir(), 'typekro-nats-operator-'));
    const container = `typekro-nats-operator-${randomUUID()}`;
    const connections: NatsConnection[] = [];
    let started = false;
    try {
      const configPath = join(directory, 'nats.conf');
      await writeFile(
        configPath,
        `jetstream { store_dir: "/tmp/jetstream" }\n${issued.serverConfig}`
      );
      await docker([
        'run',
        '--rm',
        '--detach',
        '--pull=never',
        '--name',
        container,
        '--publish',
        '127.0.0.1::4222',
        '--mount',
        `type=bind,source=${configPath},target=/etc/nats/operator.conf,readonly`,
        IMAGE,
        '-c',
        '/etc/nats/operator.conf',
      ]);
      started = true;
      const server = await docker(['port', container, '4222/tcp']);
      const worker = await connectUser(directory, server, workerUser);
      connections.push(worker);
      const responder = await connectUser(directory, server, responderUser);
      connections.push(responder);
      const subject = 'orders.events';
      responder.subscribe(subject, {
        callback: (error, message) => {
          if (!error) message.respond(message.data);
        },
      });
      await responder.flush();
      const reply = await worker.request(subject, 'hello', { timeout: 2_000 });
      expect(reply.string()).toBe('hello');

      await expectDenied(worker, 'publish', 'billing.events', () =>
        worker.publish('billing.events')
      );
      await expectRequestDenied(worker, '$JS.API.STREAM.LIST');
      const otherInbox = `${responderUser.inboxPrefix}.probe`;
      responder.subscribe(otherInbox);
      await responder.flush();
      await expectDenied(worker, 'subscription', otherInbox, () => worker.subscribe(otherInbox));

      const admin = await connectUser(directory, server, adminUser);
      connections.push(admin);
      const scoped = await connectUser(directory, server, scopedUser);
      connections.push(scoped);
      for (const [client, stream, subject] of [
        [scoped, 'ORDERS', 'orders.jetstream.>'],
        [admin, 'AUDIT', 'orders.audit.>'],
      ] as const) {
        const created = await client.request(
          `$JS.API.STREAM.CREATE.${stream}`,
          JSON.stringify({ name: stream, subjects: [subject], storage: 'memory' }),
          { timeout: 2_000 }
        );
        expect(created.json()).toMatchObject({ config: { name: stream } });
      }
      const listed = await admin.request('$JS.API.STREAM.LIST', '{}', { timeout: 2_000 });
      expect(listed.json()).toMatchObject({ total: 2 });
      await expectRequestDenied(scoped, '$JS.API.STREAM.INFO.AUDIT');
      await expectRequestDenied(scoped, '$JS.API.STREAM.LIST');
      const consumer = await scoped.request(
        '$JS.API.CONSUMER.CREATE.ORDERS.reader',
        JSON.stringify({
          stream_name: 'ORDERS',
          config: { name: 'reader', ack_policy: 'explicit' },
        }),
        { timeout: 2_000 }
      );
      expect(consumer.json()).toMatchObject({ name: 'reader' });
      const published = await scoped.request('orders.jetstream.received', 'stored', {
        timeout: 2_000,
      });
      expect(published.json()).toMatchObject({ stream: 'ORDERS', seq: 1 });
      const delivery = await scoped.request(
        '$JS.API.CONSUMER.MSG.NEXT.ORDERS.reader',
        JSON.stringify({ batch: 1, expires: 1_000_000_000 }),
        // Pull deliveries use the original message subject, so use a dedicated inbox.
        { timeout: 2_000, noMux: true }
      );
      expect(delivery.string()).toBe('stored');
      if (!delivery.reply) throw new Error('Expected an acknowledgement subject');
      await scoped.request(delivery.reply, '+ACK', { timeout: 2_000 });
    } finally {
      await Promise.allSettled(connections.map((connection) => connection.close()));
      try {
        if (started) await docker(['stop', '--time', '2', container]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 35_000);
});
