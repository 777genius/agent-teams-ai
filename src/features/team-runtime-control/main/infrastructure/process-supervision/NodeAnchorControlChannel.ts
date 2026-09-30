import {
  type OwnedProcessRef,
  PROCESS_SUPERVISION_MAX_FRAME_BYTES,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnershipScope,
  ProcessSupervisionProtocolError,
} from '../../../contracts/processSupervision';
import {
  type MonotonicClockPort,
  type ProcessSupervisionDeadline,
  runBoundedProcessSupervisionEffect,
} from '../../../core/application/process-supervision';

import type { RuntimeCancellation } from '../../../core/application/ports';

export interface AnchorStopControlFrame extends ProcessOwnershipScope {
  readonly protocolVersion: typeof PROCESS_SUPERVISION_PROTOCOL_VERSION;
  readonly type: 'stop';
  readonly sequence: number;
  readonly processRef: OwnedProcessRef;
  readonly mode: 'graceful' | 'immediate';
  readonly graceMs: number;
}

export interface NodeAnchorControlSink {
  write(
    bytes: Uint8Array,
    options: { readonly remainingTimeMs: number; readonly cancellation: RuntimeCancellation }
  ): Promise<void>;
  close(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<void>;
}

export class NodeAnchorControlChannel {
  constructor(
    readonly channelRef: string,
    private readonly sink: NodeAnchorControlSink
  ) {}

  async writeStop(
    frame: AnchorStopControlFrame,
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<void> {
    const encoded = encodeAnchorControlFrame(frame);
    await runBoundedProcessEffect(
      'control-write',
      deadline,
      clock,
      cancellation,
      async (remainingTimeMs) => await this.sink.write(encoded, { remainingTimeMs, cancellation })
    );
  }

  async close(
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<void> {
    await runBoundedProcessEffect(
      'control-pipe-close',
      deadline,
      clock,
      cancellation,
      async (remainingTimeMs) => await this.sink.close({ remainingTimeMs, cancellation })
    );
  }
}

/** Protocol serialization is infrastructure-owned and never performed by the adapter. */
export function encodeAnchorControlFrame(frame: AnchorStopControlFrame): Uint8Array {
  if (
    frame.protocolVersion !== PROCESS_SUPERVISION_PROTOCOL_VERSION ||
    frame.type !== 'stop' ||
    !Number.isSafeInteger(frame.sequence) ||
    frame.sequence < 1 ||
    (frame.mode !== 'graceful' && frame.mode !== 'immediate') ||
    !Number.isSafeInteger(frame.graceMs) ||
    frame.graceMs < 0
  ) {
    throw new ProcessSupervisionProtocolError('control-frame-invalid');
  }
  const wire = {
    protocolVersion: frame.protocolVersion,
    type: frame.type,
    sequence: frame.sequence,
    processRef: frame.processRef,
    teamId: frame.planRef.teamId,
    runId: frame.planRef.runId,
    generation: frame.planRef.generation,
    planHash: frame.planRef.planHash,
    executionUnitId: frame.executionUnitId,
    mode: frame.mode,
    graceMs: frame.graceMs,
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(wire)}\n`);
  if (bytes.byteLength > PROCESS_SUPERVISION_MAX_FRAME_BYTES) {
    throw new ProcessSupervisionProtocolError('control-frame-too-large');
  }
  return bytes;
}

export async function runBoundedProcessEffect<T>(
  operation: string,
  deadline: ProcessSupervisionDeadline,
  clock: MonotonicClockPort,
  cancellation: RuntimeCancellation,
  effect: (remainingTimeMs: number) => Promise<T>
): Promise<T> {
  return await runBoundedProcessSupervisionEffect(operation, deadline, clock, cancellation, effect);
}
