import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  type AnchorChannelRef,
  type AnchorIdentityRef,
  isExactProcessOwnershipScope,
  type MainProcessIdentityRef,
  type OwnedProcessRef,
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseProcessSupervisionSha256,
  PROCESS_SUPERVISION_MAX_FRAME_BYTES,
  PROCESS_SUPERVISION_MAX_STATUS_FRAMES,
  PROCESS_SUPERVISION_MAX_STATUS_STREAM_BYTES,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnershipPlanRef,
  ProcessSupervisionProtocolError,
  type ProcessWorkspaceBinding,
} from '../../../contracts/processSupervision';
import { type ExecutionUnitId, parseExecutionUnitId } from '../../../contracts/runtimePlan';

import { runBoundedProcessEffect } from './NodeAnchorControlChannel';

import type { RuntimeCancellation } from '../../../core/application/ports';
import type {
  MonotonicClockPort,
  ProcessSupervisionDeadline,
} from '../../../core/application/process-supervision';

interface AnchorStatusFrameBase {
  readonly protocolVersion: typeof PROCESS_SUPERVISION_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly processRef: OwnedProcessRef;
  readonly planRef: ProcessOwnershipPlanRef;
  readonly executionUnitId: ExecutionUnitId;
  readonly spawnNonceDigest: ReturnType<typeof parseProcessSupervisionSha256>;
  readonly channelRef: AnchorChannelRef;
}

export interface AnchorReadyStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'ready';
  readonly sequence: 1;
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly anchorIdentityRef: AnchorIdentityRef;
  readonly mainProcessIdentityRef: MainProcessIdentityRef;
}

export interface AnchorMainExitStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'main_exit';
  readonly outcome: 'success' | 'failure' | 'unknown';
}

export interface AnchorEscalationStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'escalation';
  readonly mode: 'term' | 'kill';
}

export interface AnchorDrainedStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'drained';
  readonly outcome: 'drained';
  readonly residuals: readonly [];
}

export interface AnchorUnclassifiedStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'unclassified_residual';
  readonly outcome: 'unclassified';
  readonly residuals: readonly string[];
  readonly reason: string;
}

export interface AnchorProtocolErrorStatusFrame extends AnchorStatusFrameBase {
  readonly type: 'protocol_error';
  readonly reason: string;
}

export type AnchorStatusFrame =
  | AnchorReadyStatusFrame
  | AnchorMainExitStatusFrame
  | AnchorEscalationStatusFrame
  | AnchorDrainedStatusFrame
  | AnchorUnclassifiedStatusFrame
  | AnchorProtocolErrorStatusFrame;

export interface NodeAnchorStatusSource {
  inspect(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<{ readonly status: 'live' | 'eof' | 'unavailable' }>;
  read(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<
    { readonly status: 'chunk'; readonly bytes: Uint8Array } | { readonly status: 'eof' }
  >;
}

export type NodeAnchorStatusInspection =
  | { readonly status: 'live' }
  | { readonly status: 'eof' | 'advanced' | 'unavailable' };

export class NodeAnchorStatusDecoder {
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private totalBytes = 0;
  private frameCount = 0;

  push(chunk: Uint8Array): readonly AnchorStatusFrame[] {
    if (!(chunk instanceof Uint8Array)) throw new ProcessSupervisionProtocolError('status-chunk');
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > PROCESS_SUPERVISION_MAX_STATUS_STREAM_BYTES) {
      throw new ProcessSupervisionProtocolError('status-stream-too-large');
    }
    this.buffered = concatenate(this.buffered, chunk);
    const frames: AnchorStatusFrame[] = [];
    let newline = this.buffered.indexOf(0x0a);
    while (newline >= 0) {
      if (newline === 0) throw new ProcessSupervisionProtocolError('status-frame-empty');
      if (newline > PROCESS_SUPERVISION_MAX_FRAME_BYTES) {
        throw new ProcessSupervisionProtocolError('status-frame-too-large');
      }
      const frameBytes = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.frameCount += 1;
      if (this.frameCount > PROCESS_SUPERVISION_MAX_STATUS_FRAMES) {
        throw new ProcessSupervisionProtocolError('status-frame-count');
      }
      frames.push(decodeAnchorStatusFrame(frameBytes));
      newline = this.buffered.indexOf(0x0a);
    }
    if (this.buffered.byteLength > PROCESS_SUPERVISION_MAX_FRAME_BYTES) {
      throw new ProcessSupervisionProtocolError('status-frame-too-large');
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) {
      throw new ProcessSupervisionProtocolError('status-frame-truncated');
    }
  }
}

export class NodeAnchorStatusReader {
  private readonly decoder = new NodeAnchorStatusDecoder();
  private readonly pending: AnchorStatusFrame[] = [];
  private lastSequence = 0;
  private readyFrame: AnchorReadyStatusFrame | undefined;
  private reachedStatusEof = false;

  constructor(private readonly source: NodeAnchorStatusSource) {}

  async inspect(
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<NodeAnchorStatusInspection> {
    if (this.reachedStatusEof) return { status: 'eof' };
    if (this.pending.length !== 0) return { status: 'advanced' };
    return await runBoundedProcessEffect(
      'status-inspection',
      deadline,
      clock,
      cancellation,
      async (remainingTimeMs) => await this.source.inspect({ remainingTimeMs, cancellation })
    );
  }

  async readReady(
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<AnchorReadyStatusFrame> {
    const frame = await this.readNext(deadline, clock, cancellation);
    if (frame?.type !== 'ready' || frame.sequence !== 1 || this.lastSequence !== 0) {
      throw new ProcessSupervisionProtocolError('ready-order');
    }
    this.lastSequence = frame.sequence;
    this.readyFrame = frame;
    return frame;
  }

  async readDrain(
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<AnchorDrainedStatusFrame | AnchorUnclassifiedStatusFrame> {
    const readyFrame = this.readyFrame;
    if (this.lastSequence < 1 || !readyFrame) {
      throw new ProcessSupervisionProtocolError('drain-before-ready');
    }
    let terminal: AnchorDrainedStatusFrame | AnchorUnclassifiedStatusFrame | undefined;
    while (true) {
      const frame = await this.readNext(deadline, clock, cancellation);
      if (!frame) {
        if (!terminal) {
          throw new ProcessSupervisionProtocolError('status-eof-before-terminal');
        }
        return terminal;
      }
      if (terminal) {
        throw new ProcessSupervisionProtocolError('status-frame-after-terminal');
      }
      if (!isSameStatusStream(frame, readyFrame)) {
        throw new ProcessSupervisionProtocolError('status-ownership-mismatch');
      }
      if (frame.sequence <= this.lastSequence) {
        throw new ProcessSupervisionProtocolError('status-sequence');
      }
      this.lastSequence = frame.sequence;
      switch (frame.type) {
        case 'drained':
        case 'unclassified_residual':
          terminal = frame;
          break;
        case 'main_exit':
        case 'escalation':
          break;
        case 'ready':
          throw new ProcessSupervisionProtocolError('duplicate-ready');
        case 'protocol_error':
          throw new ProcessSupervisionProtocolError(`anchor:${frame.reason}`);
      }
    }
  }

  private async readNext(
    deadline: ProcessSupervisionDeadline,
    clock: MonotonicClockPort,
    cancellation: RuntimeCancellation
  ): Promise<AnchorStatusFrame | null> {
    while (this.pending.length === 0) {
      if (this.reachedStatusEof) {
        throw new ProcessSupervisionProtocolError('status-read-after-eof');
      }
      const read = await runBoundedProcessEffect(
        'status-read',
        deadline,
        clock,
        cancellation,
        async (remainingTimeMs) => await this.source.read({ remainingTimeMs, cancellation })
      );
      if (read.status === 'eof') {
        this.decoder.finish();
        this.reachedStatusEof = true;
        return null;
      }
      if (read.bytes.byteLength === 0) {
        throw new ProcessSupervisionProtocolError('status-chunk-empty');
      }
      this.pending.push(...this.decoder.push(read.bytes));
    }
    return this.pending.shift()!;
  }
}

function isSameStatusStream(frame: AnchorStatusFrame, readyFrame: AnchorReadyStatusFrame): boolean {
  return (
    frame.processRef === readyFrame.processRef &&
    frame.channelRef === readyFrame.channelRef &&
    frame.spawnNonceDigest === readyFrame.spawnNonceDigest &&
    isExactProcessOwnershipScope(frame, readyFrame)
  );
}

/** Strict UTF-8, strict object shape, bounded frame decoder. */
export function decodeAnchorStatusFrame(bytes: Uint8Array): AnchorStatusFrame {
  if (bytes.byteLength === 0 || bytes.byteLength > PROCESS_SUPERVISION_MAX_FRAME_BYTES) {
    throw new ProcessSupervisionProtocolError('status-frame-size');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProcessSupervisionProtocolError('status-frame-utf8');
  }
  if (text.includes('\r') || text.includes('\n')) {
    throw new ProcessSupervisionProtocolError('status-frame-newline');
  }
  rejectDuplicateObjectKeys(text);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProcessSupervisionProtocolError('status-frame-json');
  }
  const record = requirePlainRecord(value);
  const type = record.type;
  if (typeof type !== 'string') throw new ProcessSupervisionProtocolError('status-frame-type');
  const common = parseCommon(record);

  switch (type) {
    case 'ready': {
      requireExactKeys(record, [
        ...COMMON_WIRE_KEYS,
        'type',
        'workspaceBinding',
        'anchorIdentityRef',
        'mainProcessIdentityRef',
      ]);
      if (common.sequence !== 1) throw new ProcessSupervisionProtocolError('ready-sequence');
      const workspace = requirePlainRecord(record.workspaceBinding);
      requireExactKeys(workspace, [
        'workspaceId',
        'registrationRevision',
        'bindingGeneration',
        'mountGeneration',
      ]);
      return Object.freeze({
        ...common,
        type: 'ready',
        sequence: 1,
        workspaceBinding: Object.freeze({
          workspaceId: parseWorkspaceId(workspace.workspaceId),
          registrationRevision: requirePositiveInteger(workspace.registrationRevision),
          bindingGeneration: requirePositiveInteger(workspace.bindingGeneration),
          mountGeneration: requirePositiveInteger(workspace.mountGeneration),
        }),
        anchorIdentityRef: parseAnchorIdentityRef(record.anchorIdentityRef),
        mainProcessIdentityRef: parseMainProcessIdentityRef(record.mainProcessIdentityRef),
      });
    }
    case 'main_exit':
      requireExactKeys(record, [...COMMON_WIRE_KEYS, 'type', 'outcome']);
      if (!['success', 'failure', 'unknown'].includes(String(record.outcome))) {
        throw new ProcessSupervisionProtocolError('main-exit-outcome');
      }
      return Object.freeze({
        ...common,
        type,
        outcome: record.outcome as AnchorMainExitStatusFrame['outcome'],
      });
    case 'escalation':
      requireExactKeys(record, [...COMMON_WIRE_KEYS, 'type', 'mode']);
      if (record.mode !== 'term' && record.mode !== 'kill') {
        throw new ProcessSupervisionProtocolError('escalation-mode');
      }
      return Object.freeze({ ...common, type, mode: record.mode });
    case 'drained':
      requireExactKeys(record, [...COMMON_WIRE_KEYS, 'type', 'outcome', 'residuals']);
      if (
        record.outcome !== 'drained' ||
        !Array.isArray(record.residuals) ||
        record.residuals.length
      ) {
        throw new ProcessSupervisionProtocolError('drained-shape');
      }
      return Object.freeze({
        ...common,
        type,
        outcome: 'drained',
        residuals: Object.freeze([] as const),
      });
    case 'unclassified_residual': {
      requireExactKeys(record, [...COMMON_WIRE_KEYS, 'type', 'outcome', 'residuals', 'reason']);
      if (record.outcome !== 'unclassified') {
        throw new ProcessSupervisionProtocolError('unclassified-outcome');
      }
      return Object.freeze({
        ...common,
        type,
        outcome: 'unclassified',
        residuals: parseResiduals(record.residuals),
        reason: requireBoundedString(record.reason, 1, 256, 'unclassified-reason'),
      });
    }
    case 'protocol_error':
      requireExactKeys(record, [...COMMON_WIRE_KEYS, 'type', 'reason']);
      return Object.freeze({
        ...common,
        type,
        reason: requireBoundedString(record.reason, 1, 256, 'protocol-error-reason'),
      });
    default:
      throw new ProcessSupervisionProtocolError('status-frame-type');
  }
}

const COMMON_WIRE_KEYS = [
  'protocolVersion',
  'sequence',
  'processRef',
  'teamId',
  'runId',
  'generation',
  'planHash',
  'executionUnitId',
  'spawnNonceDigest',
  'channelRef',
] as const;

function parseCommon(record: Record<string, unknown>): AnchorStatusFrameBase {
  if (record.protocolVersion !== PROCESS_SUPERVISION_PROTOCOL_VERSION) {
    throw new ProcessSupervisionProtocolError('protocol-version');
  }
  return {
    protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
    sequence: requirePositiveInteger(record.sequence),
    processRef: parseOwnedProcessRef(record.processRef),
    planRef: Object.freeze({
      teamId: parseTeamId(record.teamId),
      runId: parseRunId(record.runId),
      generation: requirePositiveInteger(record.generation),
      planHash: parseProcessSupervisionSha256(
        record.planHash
      ) as ProcessOwnershipPlanRef['planHash'],
    }),
    executionUnitId: parseExecutionUnitId(record.executionUnitId),
    spawnNonceDigest: parseProcessSupervisionSha256(record.spawnNonceDigest),
    channelRef: parseAnchorChannelRef(record.channelRef),
  };
}

function parseResiduals(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ProcessSupervisionProtocolError('residuals');
  }
  return Object.freeze(value.map((entry) => requireBoundedString(entry, 1, 128, 'residual-entry')));
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProcessSupervisionProtocolError('status-frame-object');
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ProcessSupervisionProtocolError('status-frame-fields');
  }
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProcessSupervisionProtocolError('status-frame-integer');
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  diagnostic: string
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes('\u0000')
  ) {
    throw new ProcessSupervisionProtocolError(diagnostic);
  }
  return value;
}

function rejectDuplicateObjectKeys(text: string): void {
  let offset = 0;

  const skipWhitespace = (): void => {
    while (/\s/.test(text[offset] ?? '')) offset += 1;
  };

  const scanString = (): string | undefined => {
    if (text[offset] !== '"') return undefined;
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '\\') {
        offset += 2;
        continue;
      }
      offset += 1;
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };

  const scanValue = (): void => {
    skipWhitespace();
    if (text[offset] === '{') {
      scanObject();
      return;
    }
    if (text[offset] === '[') {
      scanArray();
      return;
    }
    if (text[offset] === '"') {
      scanString();
      return;
    }
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1;
  };

  const scanObject = (): void => {
    offset += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (text[offset] === '}') {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      skipWhitespace();
      const key = scanString();
      if (key === undefined) return;
      if (keys.has(key)) {
        throw new ProcessSupervisionProtocolError('status-frame-duplicate-key');
      }
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ':') return;
      offset += 1;
      scanValue();
      skipWhitespace();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') return;
      offset += 1;
    }
  };

  const scanArray = (): void => {
    offset += 1;
    skipWhitespace();
    if (text[offset] === ']') {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      scanValue();
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') return;
      offset += 1;
    }
  };

  scanValue();
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}
