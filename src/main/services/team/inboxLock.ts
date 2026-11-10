const WRITE_LOCKS = new Map<string, Promise<void>>();

export async function withInboxLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = WRITE_LOCKS.get(inboxPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  WRITE_LOCKS.set(inboxPath, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (WRITE_LOCKS.get(inboxPath) === mine) {
      WRITE_LOCKS.delete(inboxPath);
    }
  }
}
