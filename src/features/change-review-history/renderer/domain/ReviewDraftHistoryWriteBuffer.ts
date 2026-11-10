/**
 * Coalesces the newest draft while preserving an unacknowledged predecessor exactly.
 * The predecessor must be retried first because its IPC reply may have been lost after commit.
 */
export class ReviewDraftHistoryWriteBuffer<T> {
  private readonly pending = new Map<string, T>();
  private readonly failed = new Map<string, T>();

  enqueue(key: string, value: T): void {
    this.pending.set(key, value);
  }

  takeNext(key: string): T | undefined {
    const failed = this.failed.get(key);
    if (failed !== undefined) {
      this.failed.delete(key);
      return failed;
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) this.pending.delete(key);
    return pending;
  }

  markFailed(key: string, value: T): void {
    this.failed.set(key, value);
  }

  peekPending(key: string): T | undefined {
    return this.pending.get(key);
  }

  peekFailed(key: string): T | undefined {
    return this.failed.get(key);
  }

  /** Records one durably-promoted descendant without dropping a newer queued value. */
  promotePendingToFailed(key: string, expectedFailed: T, promoted: T): boolean {
    if (this.failed.get(key) !== expectedFailed) return false;
    this.failed.set(key, promoted);
    if (this.pending.get(key) === promoted) this.pending.delete(key);
    return true;
  }

  /** Resolves the failed predecessor and optionally returns the newest descendant for rebasing. */
  resolveConflict(key: string, preservePending: boolean): T | undefined {
    this.failed.delete(key);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    return preservePending ? pending : undefined;
  }

  keys(prefix: string): string[] {
    return [...new Set([...this.pending.keys(), ...this.failed.keys()])].filter((key) =>
      key.startsWith(prefix)
    );
  }

  hasPending(key: string): boolean {
    return this.pending.has(key);
  }

  hasPendingWithPrefix(prefix: string): boolean {
    return [...this.pending.keys()].some((key) => key.startsWith(prefix));
  }

  hasFailedWithPrefix(prefix: string): boolean {
    return [...this.failed.keys()].some((key) => key.startsWith(prefix));
  }
}
