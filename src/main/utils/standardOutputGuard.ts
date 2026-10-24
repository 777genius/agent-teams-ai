import type { Writable } from 'node:stream';

const installedGuards = new WeakMap<Writable, () => void>();
type WriteCallback = (error: Error | null | undefined) => void;
type WriteArguments =
  | [chunk: unknown, callback?: WriteCallback]
  | [chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback];

function isBrokenPipe(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPIPE';
}

/** Only best-effort stdout/stderr output can be abandoned when its reader exits. */
export function installStandardOutputGuard(stream: Writable): () => void {
  const installed = installedGuards.get(stream);
  if (installed) return installed;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply preserves the write receiver.
  const originalWrite = stream.write;
  let broken = false;
  const onError = (error: Error): void => {
    if (isBrokenPipe(error)) {
      broken = true;
      return;
    }
    // Preserve observers (including Sentry) and EventEmitter's unhandled-error contract.
    if (stream.listenerCount('error') === 1) throw error;
  };
  const guardedWrite: Writable['write'] = function (
    this: Writable,
    ...args: WriteArguments
  ): boolean {
    if (!broken) {
      try {
        return Reflect.apply(originalWrite, this, args) as boolean;
      } catch (error) {
        if (!isBrokenPipe(error)) throw error;
        broken = true;
      }
    }
    const callback = typeof args[1] === 'function' ? args[1] : args[2];
    // Deliberately discarded output is complete; no drain will follow it.
    if (callback) process.nextTick(callback);
    return true;
  };
  stream.on('error', onError);
  stream.write = guardedWrite;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (stream.write === guardedWrite) stream.write = originalWrite;
    stream.off('error', onError);
    if (installedGuards.get(stream) === dispose) installedGuards.delete(stream);
  };
  installedGuards.set(stream, dispose);
  return dispose;
}
