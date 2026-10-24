import type { ReadFileResult } from '@shared/types/editor';

/** Observe both outcomes so cleanup never creates an unhandled rejected promise. */
export function deduplicateEditorRead(
  pending: Map<string, Promise<ReadFileResult>>,
  filePath: string,
  read: () => Promise<ReadFileResult>
): Promise<ReadFileResult> {
  const existing = pending.get(filePath);
  if (existing) return existing;
  const promise = read();
  pending.set(filePath, promise);
  const cleanup = (): void => {
    if (pending.get(filePath) === promise) pending.delete(filePath);
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
