export interface NativeGateEvents {
  readonly guard: <Args extends unknown[]>(
    callback: (...args: Args) => void
  ) => (...args: Args) => void;
  readonly wait: <T>(operation: Promise<T>) => Promise<T>;
}

// EventEmitter does not turn a thrown listener exception into an awaited rejection.
// Keep the first failure alive across readiness, drain and release waits so finally owns cleanup.
export function createNativeGateEvents(): NativeGateEvents {
  let firstFailure: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_done, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => undefined); // a callback may fail between two awaited operations
  return {
    guard:
      (callback) =>
      (...args) => {
        try {
          callback(...args);
        } catch (error) {
          if (firstFailure) return;
          firstFailure = error instanceof Error ? error : new Error('Native gate callback failed');
          rejectFailure(firstFailure);
        }
      },
    wait: async (operation) => {
      // Observe even an already rejected operation when the event failure won first.
      const result = Promise.race([failed, operation]);
      if (firstFailure) {
        void result.catch(() => undefined);
        throw firstFailure;
      }
      return result;
    },
  };
}
