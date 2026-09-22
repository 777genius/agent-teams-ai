import type { HostedProducerProvenance } from '@features/hosted-producer-provenance/main';

/** One native writer for the Product process, immutable views for each Owner.
 * Closing a view cannot close/reopen the process's inherited evidence FDs. */
export class HostedApprovalGenerationProvenance {
  private current: { invalidate(error: Error): void } | undefined;
  private failure: Error | undefined;

  constructor(private readonly writer: HostedProducerProvenance, onFailure: (error: Error) => void) {
    writer.bindInvalidation(error => {
      this.failure ??= error;
      try { this.current?.invalidate(error); } finally { onFailure(error); }
    });
  }

  open(): HostedProducerProvenance {
    if (this.failure) throw this.failure;
    if (this.current) throw new Error('approval_generation_evidence_overlap');
    let closed = false;
    let invalidate: ((error: Error) => void) | undefined;
    const scope = { invalidate: (error: Error) => invalidate?.(error) };
    this.current = scope;
    const writer = this.writer;
    return Object.freeze({
      role: writer.role, controllerNonce: writer.controllerNonce, runId: writer.runId,
      emit: (stream, record) => {
        if (closed) throw new Error('approval_generation_evidence_revoked');
        writer.emit(stream, record);
      },
      poison: (reason: string): never => writer.poison(reason),
      bindInvalidation: (callback: (error: Error) => void) => {
        if (closed || invalidate) throw new Error('approval_generation_evidence_binding');
        invalidate = callback;
        if (this.failure) callback(this.failure);
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.current === scope) this.current = undefined;
      },
    } satisfies HostedProducerProvenance);
  }

  close(): void { this.writer.close(); }
}
