import { AsyncLocalStorage } from 'node:async_hooks';

const atomicWriteCommitGuard = new AsyncLocalStorage<(targetPath: string) => void>();

/** Carries a run's generation fence to every nested atomic file publication. */
export function withAtomicWriteCommitGuard<T>(
  guard: (targetPath: string) => void,
  operation: () => Promise<T>
): Promise<T> {
  const inherited = atomicWriteCommitGuard.getStore();
  return atomicWriteCommitGuard.run((targetPath) => {
    inherited?.(targetPath);
    guard(targetPath);
  }, operation);
}

export function assertAtomicWriteCommitGuard(targetPath: string): void {
  atomicWriteCommitGuard.getStore()?.(targetPath);
}
