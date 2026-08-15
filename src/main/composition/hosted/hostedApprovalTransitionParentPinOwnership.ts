import type { FileHandle } from 'node:fs/promises';

interface ParentPin {
  readonly handle: FileHandle;
}

/** Owns an opened parent pin until an exchange synchronously accepts it or aborts. */
export class HostedApprovalTransitionParentPinOwnership<T extends ParentPin> {
  private handle: FileHandle | null = null;
  private closePromise: Promise<void> | null = null;
  private transferred = false;

  acquire(handle: FileHandle): void {
    if (this.closePromise || this.handle || this.transferred) {
      void Promise.resolve()
        .then(() => handle.close())
        .catch(() => undefined);
      throw new Error('hosted-approval-transition-parent-pin-ownership-invalid');
    }
    this.handle = handle;
  }

  assertAcquired(handle: FileHandle): void {
    if (this.closePromise || this.handle !== handle)
      throw new Error('hosted-approval-transition-parent-pin-aborted');
  }

  transfer(parent: T): T {
    this.assertAcquired(parent.handle);
    this.transferred = true;
    return parent;
  }

  closeWithoutWaiting(): void {
    void this.close();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const handle = this.handle;
    this.handle = null;
    this.closePromise = handle
      ? Promise.resolve()
          .then(() => handle.close())
          .catch(() => undefined)
      : Promise.resolve();
    return this.closePromise;
  }
}
