export type CombinedAbortSignal = {
  readonly signal: AbortSignal;
  dispose(): void;
};

export function combineAbortSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): CombinedAbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    signal !== undefined
  );
  if (activeSignals.length === 0) {
    return {
      signal: new AbortController().signal,
      dispose: () => undefined,
    };
  }
  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0]!,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  for (const signal of activeSignals) {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", abort));
  }
  if (controller.signal.aborted) {
    for (const cleanup of cleanups.splice(0)) cleanup();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
