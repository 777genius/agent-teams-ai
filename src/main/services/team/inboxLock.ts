const writeLocks = new Map<string, Promise<void>>();

export async function withInboxLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(inboxPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(inboxPath, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(inboxPath) === mine) {
      writeLocks.delete(inboxPath);
    }
  }
}
