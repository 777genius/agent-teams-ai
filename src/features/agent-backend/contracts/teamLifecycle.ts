import type { QueuedUserMessageSummary } from '@shared/types/team';
/** Product tombstone/retained debt; never a provider stop or released-custody claim. */
export interface BackendTeamLifecycle {
  kind: 'team_lifecycle';
  revision: string;
  deletedAt: string | null;
  cleanupPending: boolean;
  /** Explicit Delete retry only; this read never advances the original prepared deletion. */
  pendingPurge?: { commandId: string; expectedRevision: string };
}
export interface BackendTeamLifecycleRequest {
  expectedRevision: string;
  action: 'trash' | 'restore';
}
export interface BackendTeamLifecycleReceipt extends BackendTeamLifecycle {
  commandId: string;
}
export interface BackendTeamPurgeReceipt {
  kind: 'team_purge';
  commandId: string;
  transactionId: string;
  phase: 'prepared' | 'deleting' | 'deleted';
}
export interface BackendQueuedUserMessages {
  kind: 'queued_user_messages';
  member: string;
  messages: QueuedUserMessageSummary[];
}
export type BackendQueuedDiscardReceipt = { kind: 'queued_discard'; commandId: string } & (
  | { phase: 'prepared' }
  | { phase: 'completed'; discarded: number; remainingQueued: number }
);
export interface BackendTeamLifecyclePayloads {
  'team.lifecycle.read': Record<string, never>;
  'team.lifecycle.change': BackendTeamLifecycleRequest;
  'team.lifecycle.lookup': { expected: BackendTeamLifecycleRequest };
  'team.lifecycle.purge': { expectedRevision: string };
  'team.lifecycle.purge.lookup': { expected: { expectedRevision: string } };
  'team.queue.read': { member: string };
  'team.queue.discard': { member: string; messageIds: string[] };
  'team.queue.lookup': { expected: { member: string; messageIds: string[] } };
}
export type BackendTeamLifecycleValue =
  | BackendTeamLifecycle
  | BackendTeamLifecycleReceipt
  | BackendTeamPurgeReceipt
  | BackendQueuedUserMessages
  | BackendQueuedDiscardReceipt;
