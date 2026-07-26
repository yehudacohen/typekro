import { describe, expect, it } from 'bun:test';

import { TypeKroError } from '../../src/core/errors.js';
import { runStandaloneOperation } from '../../src/core/runtime/standalone-operation.js';

describe('standalone Effect operation boundary', () => {
  it('preserves the original TypeKro error identity and message', async () => {
    const expected = new TypeKroError('exact failure', 'EXACT_FAILURE', { source: 'test' });

    const actual = await runStandaloneOperation(async () => {
      throw expected;
    }).catch((error: unknown) => error);

    expect(actual).toBe(expected);
    expect(actual).toBeInstanceOf(TypeKroError);
    expect((actual as Error).message).toBe('exact failure');
  });

  it('forwards external cancellation into the operation and preserves its reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('caller stopped deployment', 'AbortError');
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const result = runStandaloneOperation(
      (abortSignal) => {
        receivedSignal = abortSignal;
        started();
        return new Promise<never>((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        });
      },
      { abortSignals: [controller.signal] }
    ).catch((error: unknown) => error);

    await operationStarted;
    controller.abort(reason);

    expect(await result).toBe(reason);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('does not start an operation when its caller is already aborted', async () => {
    const controller = new AbortController();
    const reason = new DOMException('already stopped', 'AbortError');
    controller.abort(reason);
    let invoked = false;

    const actual = await runStandaloneOperation(
      async () => {
        invoked = true;
        return 'unexpected';
      },
      { abortSignals: [controller.signal] }
    ).catch((error: unknown) => error);

    expect(invoked).toBe(false);
    expect(actual).toBe(reason);
  });
});
