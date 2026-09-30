import type { HostedTaskBoardCoreV1MutationCommand } from '../../contracts/hosted';

/** Scope-owned frozen envelope only. The existing board path still decides mutation outcomes. */
export interface HostedNonCreatePendingSnapshot {
  readonly command: HostedTaskBoardCoreV1MutationCommand | null;
  readonly inFlight: boolean;
}

export class HostedNonCreatePendingHandle {
  private snapshot: HostedNonCreatePendingSnapshot = Object.freeze({
    command: null,
    inFlight: false,
  });
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): HostedNonCreatePendingSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  claim(command: HostedTaskBoardCoreV1MutationCommand): boolean {
    if (this.snapshot.command !== null) return false;
    this.publish({ command, inFlight: true });
    return true;
  }

  beginReplay(command: HostedTaskBoardCoreV1MutationCommand): boolean {
    if (this.snapshot.command !== command || this.snapshot.inFlight) return false;
    this.publish({ command, inFlight: true });
    return true;
  }

  finishAttempt(command: HostedTaskBoardCoreV1MutationCommand): void {
    if (this.snapshot.command !== command || !this.snapshot.inFlight) return;
    this.publish({ command, inFlight: false });
  }

  settle(command: HostedTaskBoardCoreV1MutationCommand): void {
    if (this.snapshot.command !== command) return;
    this.publish({ command: null, inFlight: false });
  }

  /** Explicit operator choice; clearing this marker says nothing about the server effect. */
  dismiss(): void {
    if (this.snapshot.command === null) return;
    this.publish({ command: null, inFlight: false });
  }

  private publish(snapshot: HostedNonCreatePendingSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
