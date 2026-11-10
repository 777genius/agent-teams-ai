interface ReadEntry<T> {
  result: Promise<T>;
  expired: boolean;
}

/** Read-only sources only: timeout never licenses a replacement write or provider operation. */
export class MemberWorkSyncReadSingleFlight<T> {
  private readonly pending = new Map<string, Set<ReadEntry<T>>>();
  private count = 0;
  constructor(private readonly timeoutMs: number) {}

  run(key: string, read: () => Promise<T>): Promise<T> {
    const entries = this.pending.get(key) ?? new Set<ReadEntry<T>>();
    for (const entry of entries) if (!entry.expired) return entry.result;
    if (entries.size >= 2 || this.count >= 128) {
      return Promise.reject(new Error('member work sync read capacity exhausted'));
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((success, fail) => {
      resolve = success;
      reject = fail;
    });
    const entry = { result, expired: false };
    entries.add(entry);
    this.pending.set(key, entries);
    this.count++;
    const timer = setTimeout(() => {
      entry.expired = true;
      reject(new Error('member work sync source read timed out'));
    }, this.timeoutMs);
    timer.unref?.();
    const finish = (): void => {
      clearTimeout(timer);
      entries.delete(entry);
      this.count--;
      if (!entries.size && this.pending.get(key) === entries) this.pending.delete(key);
    };
    // Reserve before read, and observe both late success and late rejection.
    void Promise.resolve()
      .then(read)
      .then(
        (value) => {
          if (!entry.expired) resolve(value);
          finish();
        },
        (error: unknown) => {
          if (!entry.expired) reject(error);
          finish();
        }
      );
    return result;
  }
}
