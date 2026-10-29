import type { JsonValue } from '../contracts.js';
import type { RuntimeBinding, RuntimeInteraction, RuntimeSessionRecord } from './contracts.js';

export interface RuntimeActivityCursor {
  resource: string;
  hostIncarnation: string;
  sequence: number;
}
export type RuntimeActivityGapReason =
  | 'retention'
  | 'incarnation'
  | 'cursor'
  | 'oversized'
  | 'unsupported'
  | 'unattributed'
  | 'storage'
  | 'state-unpublished';
export interface RuntimeActivityGap {
  reason: RuntimeActivityGapReason;
}
export interface RuntimeActivityState {
  phase: RuntimeSessionRecord['phase'];
  custody: RuntimeSessionRecord['custody'];
  sealed: boolean;
  nativeReady: boolean;
  control: NonNullable<RuntimeSessionRecord['control']> | null;
  diagnostic: NonNullable<RuntimeSessionRecord['diagnostic']> | null;
  queuedInputs: number;
  activeInputs: number;
  interactions: RuntimeInteraction[];
  partial: boolean;
  checkpoints: { checkpointId: string; status: string; reference?: string }[];
}
export interface RuntimeActivityEvent {
  sequence: number;
  eventId: string;
  /** Host observation time; absent for retained records written before this field existed. */
  observedAt?: string;
  inputId?: string;
  operationRef?: string;
  data: Record<string, JsonValue> & { kind: string };
}
export interface RuntimeActivityRecord {
  schemaVersion: 1;
  binding: RuntimeBinding;
  sequence: number;
  writerIncarnation: string;
  stateDigest: string;
  digest: string;
  events: RuntimeActivityEvent[];
}
/** Called only while Runtime's existing member fence is held; no independent writer/lock. */
export interface RuntimeEventStorage {
  readonly activityLimits: Readonly<RuntimeActivityLimits>;
  readActivity(binding: RuntimeBinding): RuntimeActivityRecord | undefined;
  writeActivity(record: RuntimeActivityRecord): void;
}
export interface RuntimeActivityLimits {
  maxBytes: number;
  maxEvents: number;
  maxEventBytes: number;
}
export const DEFAULT_ACTIVITY_LIMITS: Readonly<RuntimeActivityLimits> = Object.freeze({
  maxBytes: 1024 * 1024,
  maxEvents: 256,
  maxEventBytes: 32 * 1024,
});
export interface RuntimeActivityFeed {
  binding: RuntimeBinding;
  cursor: RuntimeActivityCursor;
  retainedFrom: number;
  events: RuntimeActivityEvent[];
  hasMore: boolean;
  gap?: RuntimeActivityGap;
}
export interface RuntimeActivitySnapshot extends RuntimeActivityFeed {
  state: RuntimeActivityState | null;
  latest: {
    text: RuntimeActivityEvent[];
    tools: RuntimeActivityEvent[];
    usage: RuntimeActivityEvent[];
    compaction: RuntimeActivityEvent | null;
    subagents: RuntimeActivityEvent[];
    interactions: RuntimeActivityEvent[];
  };
}
