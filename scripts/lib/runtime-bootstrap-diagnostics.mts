function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function phase<T>(name: string, operation: () => Promise<T>): Promise<T>;
export function phase<T>(name: string, operation: () => T): T;
export function phase<T>(name: string, operation: () => T | PromiseLike<T>): T | PromiseLike<T> {
  const enabled = process.env.CLAUDE_DEV_RUNTIME_DIAGNOSTICS === '1';
  const started = Date.now();
  const report = (state: 'begin' | 'end' | 'error'): void => {
    if (enabled)
      process.stderr.write(
        `[runtime-bootstrap] ${name} ${state} elapsedMs=${Date.now() - started}\n`
      );
  };
  report('begin');
  try {
    const result = operation();
    if (isThenable(result)) {
      return result.then(
        (value) => {
          report('end');
          return value;
        },
        (error: unknown) => {
          report('error');
          throw error;
        }
      );
    }
    report('end');
    return result;
  } catch (error) {
    report('error');
    throw error;
  }
}
