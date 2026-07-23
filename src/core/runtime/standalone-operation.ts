interface StandaloneOperationOptions {
  readonly abortSignals?: readonly (AbortSignal | undefined)[];
}

interface CombinedAbortSignal {
  readonly signal: AbortSignal | undefined;
  readonly dispose: () => void;
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) {
    return { signal: undefined, dispose: () => undefined };
  }
  if (active.length === 1) {
    return { signal: active[0], dispose: () => undefined };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of active) {
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) {
      forward();
      break;
    }
    listeners.set(signal, forward);
    signal.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

/**
 * Run one standalone TypeKro operation in one lazily loaded Effect scope.
 *
 * The Promise facade preserves the original rejection value. Effect causes
 * and FiberFailure wrappers never cross the public boundary.
 */
export async function runStandaloneOperation<A>(
  operation: (abortSignal: AbortSignal) => Promise<A>,
  options: StandaloneOperationOptions = {}
): Promise<A> {
  const combined = combineAbortSignals(options.abortSignals ?? []);
  try {
    if (combined.signal?.aborted) {
      throw combined.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }
    const { Cause, Effect, Exit, Option } = await import('effect');
    const program = Effect.scoped(
      Effect.tryPromise({
        try: (abortSignal) => operation(abortSignal),
        catch: (error) => error,
      })
    );
    const exit = await Effect.runPromiseExit(
      program,
      combined.signal ? { signal: combined.signal } : undefined
    );
    if (Exit.isSuccess(exit)) return exit.value;

    const failure = Exit.findErrorOption(exit);
    if (Option.isSome(failure)) throw failure.value;

    if (combined.signal?.aborted) {
      throw combined.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    const rendered = Cause.prettyErrors(exit.cause);
    throw rendered[0] ?? new Error(Cause.pretty(exit.cause));
  } finally {
    combined.dispose();
  }
}
