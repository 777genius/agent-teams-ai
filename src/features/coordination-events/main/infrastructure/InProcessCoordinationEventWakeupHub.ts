import type { CoordinationEventEnvelope } from '../../contracts';
import type { CoordinationEventWakeup } from '../../core/application';

export type CoordinationEventWakeupListener = () => void;

/**
 * Process-local wake-ups are latency hints only. Notifications in the same
 * microtask turn coalesce into one listener pass; durable replay remains the
 * source of truth and listener failures cannot invalidate a committed event.
 */
export class InProcessCoordinationEventWakeupHub implements CoordinationEventWakeup {
  private readonly listeners = new Set<CoordinationEventWakeupListener>();
  private scheduledFlush: Promise<void> | null = null;
  private closed = false;

  subscribe(listener: CoordinationEventWakeupListener): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  notifyCommittedEvent(_event: CoordinationEventEnvelope): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.scheduledFlush === null) {
      this.scheduledFlush = Promise.resolve()
        .then(() => {
          for (const listener of [...this.listeners]) {
            try {
              listener();
            } catch {
              // A lossy hint listener must never change durable publish outcome.
            }
          }
        })
        .finally(() => {
          this.scheduledFlush = null;
        });
    }
    return this.scheduledFlush;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
  }
}
