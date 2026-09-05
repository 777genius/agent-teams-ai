import type { HostedCoordinationEventStreamScheduler } from './HostedCoordinationEventWakeSignal';
import type {
  HostedCoordinationEventStreamWriteDisposition,
  HostedCoordinationEventStreamWriteObservation,
  HostedCoordinationEventStreamWriteObserver,
} from '../../../application/HostedCoordinationEventStreamPorts';

export type {
  HostedCoordinationEventStreamWriteDisposition,
  HostedCoordinationEventStreamWriteObservation as HostedCoordinationEventStreamWriteDiagnostic,
  HostedCoordinationEventStreamWriteObserver as HostedCoordinationEventStreamWriteDiagnosticObserver,
} from '../../../application/HostedCoordinationEventStreamPorts';

export interface HostedCoordinationEventStreamRawResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  destroy(): unknown;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  write(frame: string): boolean;
}

type HostedCoordinationEventStreamTransportTermination =
  | 'aborted'
  | 'already_closed'
  | 'hard_destroyed'
  | 'destroy_failed'
  | 'none';

export interface HostedCoordinationEventStreamWriterOptions {
  readonly maxFrameBytes: number;
  readonly observer?: HostedCoordinationEventStreamWriteObserver;
  readonly scheduler: HostedCoordinationEventStreamScheduler;
  readonly slowConsumerTimeoutMs: number;
}

const UTF8_ENCODER = new TextEncoder();

function observe(
  observer: HostedCoordinationEventStreamWriteObserver | undefined,
  observation: HostedCoordinationEventStreamWriteObservation
): void {
  try {
    observer?.(observation);
  } catch {
    // Transport correctness must never depend on observation delivery.
  }
}

export function hostedCoordinationEventStreamWriteSucceeded(
  disposition: HostedCoordinationEventStreamWriteDisposition
): boolean {
  return disposition === 'immediate' || disposition === 'drained';
}

/** Owns one serialized raw response write, including its bounded drain lifecycle. */
export class HostedCoordinationEventStreamWriter {
  constructor(private readonly options: HostedCoordinationEventStreamWriterOptions) {}

  write(input: {
    readonly frame: string;
    readonly raw: HostedCoordinationEventStreamRawResponse;
    readonly signal: AbortSignal;
    readonly streamId: string;
  }): Promise<HostedCoordinationEventStreamWriteDisposition> {
    const { frame, raw, signal, streamId } = input;
    if (signal.aborted) {
      return Promise.resolve(this.terminal(streamId, 'aborted', 'aborted'));
    }
    if (raw.destroyed || raw.writableEnded) {
      return Promise.resolve(this.terminal(streamId, 'closed', 'already_closed'));
    }
    if (UTF8_ENCODER.encode(frame).byteLength > this.options.maxFrameBytes) {
      return Promise.resolve(this.terminal(streamId, 'oversized', 'none'));
    }
    try {
      if (raw.write(frame)) return Promise.resolve('immediate');
    } catch {
      return Promise.resolve(this.terminal(streamId, 'write_failed', 'none'));
    }

    observe(this.options.observer, {
      kind: 'backpressure_entered',
      streamId,
      timeoutMs: this.options.slowConsumerTimeoutMs,
    });
    return new Promise<HostedCoordinationEventStreamWriteDisposition>((resolve) => {
      let settled = false;
      let cancelDeadline = (): void => undefined;
      const cleanup = (): void => {
        cancelDeadline();
        raw.removeListener('drain', onDrain);
        raw.removeListener('close', onClose);
        raw.removeListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        return true;
      };
      const onDrain = (): void => {
        if (settle()) resolve('drained');
      };
      const onClose = (): void => {
        if (settle()) resolve(this.terminal(streamId, 'closed', 'already_closed'));
      };
      const onError = (): void => {
        if (settle()) resolve(this.terminal(streamId, 'write_failed', 'none'));
      };
      const onAbort = (): void => {
        if (settle()) resolve(this.terminal(streamId, 'aborted', 'aborted'));
      };
      const onTimeout = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        let transportTermination: 'hard_destroyed' | 'destroy_failed' = 'hard_destroyed';
        try {
          // A graceful end can remain pending behind queued bytes. Destroy before resolving so
          // the controller cannot drop its final transport ownership while the peer is stalled.
          raw.destroy();
        } catch {
          transportTermination = 'destroy_failed';
        }
        resolve(this.terminal(streamId, 'timed_out', transportTermination));
      };

      raw.once('drain', onDrain);
      raw.once('close', onClose);
      raw.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      cancelDeadline = this.options.scheduler.schedule(
        this.options.slowConsumerTimeoutMs,
        onTimeout
      );
      if (settled) cancelDeadline();
      if (signal.aborted) onAbort();
      else if (raw.destroyed || raw.writableEnded) onClose();
    });
  }

  private terminal<
    TDisposition extends Exclude<
      HostedCoordinationEventStreamWriteDisposition,
      'immediate' | 'drained'
    >,
  >(
    streamId: string,
    disposition: TDisposition,
    transportTermination: HostedCoordinationEventStreamTransportTermination
  ): TDisposition {
    observe(this.options.observer, {
      kind: 'terminal',
      streamId,
      timeoutMs: this.options.slowConsumerTimeoutMs,
      disposition,
      transportTermination,
    });
    return disposition;
  }
}
