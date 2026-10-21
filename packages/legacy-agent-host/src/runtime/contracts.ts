import type {
  DriverFactory,
  InteractionReply,
  OpenConfig,
} from '@agent-teams/provider-session-contracts';
import type { JsonValue } from '../contracts.js';
import type { CheckpointAttempt, CheckpointStorage } from './checkpointContracts.js';

export interface RuntimeBinding {
  backendId: string;
  teamId: string;
  runId: string;
  memberId: string;
  generation: string;
}

export interface RuntimeDelivery {
  binding: RuntimeBinding;
  deliveryId: string;
  inputId: string;
  messageId: string;
  content: string;
}

export interface RuntimeAdmission {
  inputId: string;
  outcome: 'admitted' | 'not_admitted' | 'unknown';
  receipt?: JsonValue;
}

export interface RuntimeInput {
  intent: RuntimeDelivery;
  fingerprint: string;
  operationRef: string;
  phase:
    | 'admitted'
    | 'claimed'
    | 'consumed'
    | 'terminal'
    | 'cancelled'
    | 'rejected'
    | 'not-sent'
    | 'unknown';
  terminal?: 'succeeded' | 'failed' | 'cancelled';
}

export interface RuntimeInteraction {
  interactionRef: string;
  inputId: string;
  operationRef: string;
  kind: InteractionReply['kind'];
  expiresAt: number;
  phase: 'pending' | 'responding' | 'resolved' | 'unknown';
}

export interface RuntimeSessionRecord {
  schemaVersion: 1;
  binding: RuntimeBinding;
  profileId: string;
  config: OpenConfig | null;
  openFingerprint: string | null;
  hostIncarnation: string;
  phase: 'unopened' | 'opening' | 'allocated' | 'closing' | 'closed' | 'held';
  sealed: boolean;
  custody: 'owned' | 'released' | 'unknown';
  nativeReady: boolean;
  sessionRef?: string;
  control?: { inputId: string; operationRef: string; phase: 'pending' | 'unknown' };
  closeClaimed?: boolean;
  checkpoints?: CheckpointAttempt[];
  restoredFrom?: { reference: string; sourceBinding: RuntimeBinding };
  inputs: RuntimeInput[];
  interactions: RuntimeInteraction[];
  diagnostic?:
    | 'open-unknown'
    | 'observe-ended'
    | 'observe-failed'
    | 'readiness-unavailable'
    | 'close-unknown';
}

export interface RuntimeTransaction {
  get(): RuntimeSessionRecord | undefined;
  siblings(): RuntimeSessionRecord[];
  /** Growth must preserve reserved bytes for accepted work/control settlement. */
  put(record: RuntimeSessionRecord, purpose?: 'growth'): void;
}

/** Short synchronous actions use the same member fence, including publication and revocation. */
export interface RuntimeStore {
  fenced<T>(binding: RuntimeBinding, action: (transaction: RuntimeTransaction) => T): T;
}

export interface RuntimeOwnerOptions {
  store: RuntimeStore;
  driverFactory: DriverFactory;
  profileId: string;
  hostIncarnation: string;
  /** Trusted synchronous authority check under the member fence, including lookup disclosure. */
  authorize(
    binding: RuntimeBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control',
    intent?: RuntimeDelivery
  ): boolean;
  /** Current mandatory dependency/bootstrap proof; absence safely holds work dispatch. */
  canDispatch?(binding: RuntimeBinding, intent: RuntimeDelivery): boolean;
  maxQueuedInputs?: number;
  maxInputBytes?: number;
  maxPendingInteractions?: number;
  interactionTtlMs?: number;
  checkpoints?: CheckpointStorage;
  checkpointIdleTimeoutMs?: number;
}

export class RuntimeOwnerError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'forbidden' | 'hold' | 'busy') {
    super(`Runtime operation ${code}`);
  }
}
