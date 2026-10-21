import type { OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { JsonValue } from '../contracts.js';
import type { RuntimeBinding, RuntimeOwnerOptions } from './contracts.js';

export interface CheckpointAttempt {
  checkpointId: string;
  fingerprint: string;
  hostIncarnation: string;
  status: 'capturing' | 'published' | 'unsupported' | 'held';
  reference?: string;
  historyDigest?: string;
  payloadDigest?: string;
}

/** Safe application handle. Opaque provider bytes and native session IDs stay private. */
export interface CheckpointReceipt {
  checkpointId: string;
  status: 'published' | 'unsupported' | 'held';
  reference?: string;
}

export interface CheckpointPayload {
  schemaVersion: 1;
  reference: string;
  checkpointId: string;
  fingerprint: string;
  sourceBinding: RuntimeBinding;
  profileId: string;
  sourceConfig: OpenConfig;
  sourceSessionRef: string;
  historyDigest: string;
  completedOperations: {
    inputId: string;
    operationRef: string;
    fingerprint: string;
    outcome: string;
  }[];
  opaque: JsonValue;
  digest: string;
}

/** Private storage only; never a renderer/RPC API. Existing IO guarantees apply. */
export interface CheckpointStorage {
  writeCheckpoint(payload: CheckpointPayload): void;
  readCheckpointPayload(reference: string): CheckpointPayload;
}

export interface RestoreSessionRequest {
  sourceBinding: RuntimeBinding;
  reference: string;
  binding: RuntimeBinding;
  config: OpenConfig;
}

export interface CheckpointCoordinatorOptions {
  store: RuntimeOwnerOptions['store'];
  storage?: CheckpointStorage;
  profileId: string;
  hostIncarnation: string;
  authorize: RuntimeOwnerOptions['authorize'];
  driver(binding: RuntimeBinding): Session | undefined;
  idleTimeoutMs?: number;
}
