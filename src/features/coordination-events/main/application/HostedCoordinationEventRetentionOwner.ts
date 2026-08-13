import type { CoordinationEventJournal } from '../../core/application';
import type { EventJournalWatermark } from '../../contracts';

export interface HostedCoordinationEventRetentionJournal extends CoordinationEventJournal {
  pruneThrough(throughSequence: number): Promise<EventJournalWatermark>;
}

export interface HostedCoordinationEventRetentionScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface HostedCoordinationEventRetentionPolicy {
  readonly intervalMs: number;
  readonly maxRetainedEvents: number;
}

/**
 * Sole production owner for event-journal retention. It reuses the live journal and its hosted
 * storage worker, so pruning stays ordered with append/replay operations on the single writer.
 */
export class HostedCoordinationEventRetentionOwner {
  private cancelDeadline: (() => void) | null = null;
  private closed = false;
  private running = false;

  constructor(
    private readonly journal: HostedCoordinationEventRetentionJournal,
    private readonly scheduler: HostedCoordinationEventRetentionScheduler,
    private readonly policy: HostedCoordinationEventRetentionPolicy
  ) {
    if (
      !Number.isSafeInteger(policy.intervalMs) ||
      policy.intervalMs < 50 ||
      policy.intervalMs > 86_400_000 ||
      !Number.isSafeInteger(policy.maxRetainedEvents) ||
      policy.maxRetainedEvents < 1 ||
      policy.maxRetainedEvents > 1_000_000
    ) {
      throw new TypeError('hosted-coordination-event-retention-policy-invalid');
    }
  }

  start(): void {
    if (this.closed || this.cancelDeadline !== null || this.running) return;
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
  }

  private schedule(): void {
    if (this.closed) return;
    this.cancelDeadline = this.scheduler.schedule(this.policy.intervalMs, () => {
      this.cancelDeadline = null;
      void this.run();
    });
  }

  private async run(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const watermark = await this.journal.getWatermark();
      const retained = watermark.highWatermarkSequence - watermark.retentionFloorSequence;
      if (retained > this.policy.maxRetainedEvents) {
        await this.journal.pruneThrough(
          watermark.highWatermarkSequence - this.policy.maxRetainedEvents
        );
      }
    } catch {
      // Retention is retried by the bounded scheduler. Append and replay authority stay available.
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
