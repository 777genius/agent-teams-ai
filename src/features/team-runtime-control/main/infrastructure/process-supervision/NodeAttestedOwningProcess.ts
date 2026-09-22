import {
  isExactProcessOwnerAttestation,
  parseProcessOwnerAttestation,
  type ProcessOwnerAttestation,
} from '../../../contracts/processSupervision';

import type { RuntimeCancellation } from '../../../core/application/ports';
import type {
  AttestedOwningProcessPort,
  OwningProcessInspection,
} from '../../adapters/output/process-supervision/AnchorProcessSupervisorAdapter';
import type { ChildProcess } from 'node:child_process';

/** Boot-local ownership proof bound to one exact ChildProcess object and its close/EOF event. */
export class NodeAttestedOwningProcess implements AttestedOwningProcessPort {
  private closed = false;
  private readonly closedPromise: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    private readonly attestation: ProcessOwnerAttestation
  ) {
    this.attestation = parseProcessOwnerAttestation(attestation);
    this.closedPromise = new Promise<void>((resolve) => {
      child.once('close', () => {
        this.closed = true;
        resolve();
      });
    });
  }

  async inspect(options: {
    readonly attestation: ProcessOwnerAttestation;
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<OwningProcessInspection> {
    if (!this.matches(options.attestation)) return { status: 'mismatch' };
    if (!hasUsableBudget(options.remainingTimeMs) || isCancelled(options.cancellation)) {
      return { status: 'unavailable' };
    }
    return this.closed
      ? { status: 'eof', ownerAttestation: this.attestation }
      : { status: 'live', ownerAttestation: this.attestation };
  }

  async waitForEof(options: {
    readonly attestation: ProcessOwnerAttestation;
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<
    | { readonly status: 'eof'; readonly ownerAttestation: ProcessOwnerAttestation }
    | { readonly status: 'mismatch' | 'unavailable' }
  > {
    if (!this.matches(options.attestation)) return { status: 'mismatch' };
    if (!hasUsableBudget(options.remainingTimeMs) || isCancelled(options.cancellation)) {
      return { status: 'unavailable' };
    }
    if (this.closed) return { status: 'eof', ownerAttestation: this.attestation };

    const completed = await waitBounded(
      this.closedPromise,
      options.remainingTimeMs,
      options.cancellation
    );
    return completed && this.closed
      ? { status: 'eof', ownerAttestation: this.attestation }
      : { status: 'unavailable' };
  }

  private matches(value: ProcessOwnerAttestation): boolean {
    try {
      return isExactProcessOwnerAttestation(parseProcessOwnerAttestation(value), this.attestation);
    } catch {
      return false;
    }
  }
}

function hasUsableBudget(remainingTimeMs: number): boolean {
  return Number.isFinite(remainingTimeMs) && remainingTimeMs > 0;
}

function isCancelled(cancellation: RuntimeCancellation): boolean {
  try {
    return cancellation.isCancellationRequested();
  } catch {
    return true;
  }
}

async function waitBounded(
  effect: Promise<void>,
  remainingTimeMs: number,
  cancellation: RuntimeCancellation
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellationPoll);
      resolve(result);
    };
    const timeout = setTimeout(
      () => settle(false),
      Math.min(Math.ceil(remainingTimeMs), 2_147_483_647)
    );
    const cancellationPoll = setInterval(
      () => {
        if (isCancelled(cancellation)) settle(false);
      },
      Math.min(5, Math.max(1, Math.ceil(remainingTimeMs)))
    );
    void effect.then(
      () => settle(!isCancelled(cancellation)),
      () => settle(false)
    );
  });
}
