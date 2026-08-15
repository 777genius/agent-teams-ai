import type { FileHandle } from 'node:fs/promises';

interface ParentPin {
  readonly handle: FileHandle;
}

/** Owns an opened parent pin until an exchange synchronously accepts it or aborts. */
export class HostedApprovalTransitionParentPinOwnership<T extends ParentPin> {
  private handle: FileHandle | null = null;
  private aborted = false;
  private transferred = false;

  async acquire(handle: FileHandle): Promise<void> {
    if (this.aborted || this.handle || this.transferred) {
      await handle.close().catch(() => undefined);
      throw new Error('hosted-approval-transition-parent-pin-ownership-invalid');
    }
    this.handle = handle;
  }

  assertAcquired(handle: FileHandle): void {
    if (this.aborted || this.handle !== handle)
      throw new Error('hosted-approval-transition-parent-pin-aborted');
  }

  transfer(parent: T): T {
    this.assertAcquired(parent.handle);
    this.handle = null;
    this.transferred = true;
    return parent;
  }

  async abort(): Promise<void> {
    if (this.aborted || this.transferred) return;
    this.aborted = true;
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
  }
}
