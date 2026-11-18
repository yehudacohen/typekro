// Joins the kro-deployed Rivet engine as a node, then completes one action round-trip.
// Reads RIVET_ENDPOINT, RIVET_TOKEN, RIVET_NAMESPACE and RIVET_POOL, as Alchemy's pool nodes do.
import { actor, setup } from 'rivetkit';
import { createClient } from 'rivetkit/client';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const endpoint = required('RIVET_ENDPOINT');
const token = required('RIVET_TOKEN');
const namespace = required('RIVET_NAMESPACE');
required('RIVET_POOL');

const counter = actor({
  state: { count: 0 },
  actions: {
    increment: (c, amount: number) => {
      c.state.count += amount;
      return c.state.count;
    },
  },
});

const registry = setup({ use: { counter } });
const started = Date.now();
// RivetKit can reject outside the awaited call (an auth error from its action retry loop), so
// failures are reported from the process handlers as well as the catch block.
const fail = (error: unknown) => {
  console.log(
    JSON.stringify({ step: 'rivetkit round-trip', ok: false, error: String(error).slice(0, 500) })
  );
  process.exit(1);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 120_000);
const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);

try {
  registry.start();
  const client = createClient<typeof registry>({ endpoint, token, namespace });
  const first = await client.counter.getOrCreate(['typekro-probe']).increment(5);
  const second = await client.counter.getOrCreate(['typekro-probe']).increment(2);
  clearTimeout(timer);
  const ok = first === 5 && second === 7;
  console.log(
    JSON.stringify({ step: 'rivetkit round-trip', ok, first, second, ms: Date.now() - started })
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  fail(error);
}
