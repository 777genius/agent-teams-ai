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
  /** Same member fence and derived owner; never read for ordinary tool/state observations. */
  readConversation?(binding: RuntimeBinding): RuntimeConversationRecord | undefined;
  writeConversation?(record: RuntimeConversationRecord): void;
  /** Exact-path presence only, for refusing lost original state without decoding text in a poll. */
  hasRetainedActivity?(binding: RuntimeBinding): boolean;
}
export const CONVERSATION_GAPS = ['legacy-history', 'undated', 'retention', 'oversized',
  'unattributed', 'storage', 'state-unpublished', 'unsupported'] as const;
export type RuntimeConversationGap = typeof CONVERSATION_GAPS[number];
export interface RuntimeConversationMarker {
  sequence: number;
  digest: string;
  gaps: RuntimeConversationGap[];
}
export interface RuntimeConversationMessage {
  messageId: string;
  inputId: string;
  operationRef: string;
  messageRef: string;
  firstSequence: number;
  observedAt: string;
  blocks: { block: number; sequence: number; text: string; phase: 'snapshot' | 'complete' }[];
}
export interface RuntimeConversationRecord extends RuntimeConversationMarker {
  schemaVersion: 1;
  binding: RuntimeBinding;
  messages: RuntimeConversationMessage[];
}
export interface RuntimeConversationRead {
  binding: RuntimeBinding;
  revision: string;
  gaps: RuntimeConversationGap[];
  messages?: RuntimeConversationMessage[];
}
export const CONVERSATION_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024, messages: 150,
});
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
  /** Final retained Host observation time for internal projections, not outcome/custody proof. */
  lastObservedAt?: string;
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
