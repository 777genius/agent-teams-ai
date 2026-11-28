import type { CommandReceipt, ImmutableDelivery, RuntimeMemberBinding, TeamCommand } from './contracts.js';

export interface AutonomousGoalOptions {
  durationHours: number;
  maxAttempts: number;
}

export interface GoalAssociation {
  goalId: string;
  revision: number;
}

/** Captured by the native composition, never parsed from model/tool arguments. */
export interface GoalInputSource {
  binding: RuntimeMemberBinding;
  inputId: string;
  operationRef: string;
  inputFingerprint: string;
}

export interface GoalContinuation {
  target: RuntimeMemberBinding;
  source: GoalInputSource;
  obligationKey: string;
  evidenceFingerprint: string;
  reason: 'productive' | 'recovery' | 'wait';
  sequence: number;
  text: string;
}

/** Optional original receipt metadata; absent metadata preserves historical hashes. */
export interface GoalCommandOrigin extends GoalAssociation {
  kind: 'intake' | 'input' | 'task' | 'continuation' | 'result';
  source?: GoalInputSource;
  continuation?: GoalContinuation;
}

export interface GoalProposalRequest {
  commandId: string;
  result: string;
  /** Exact artifact/check references are lead attestations unless canonical task evidence proves them. */
  evidence?: string;
}

export interface GoalProposal extends GoalProposalRequest {
  source: GoalInputSource;
  principalId: string;
  revision: number;
  authorityRevision: number;
  taskFingerprint: string;
  evidenceFingerprint: string;
  resultMessageId: string;
}

export interface GoalRecord extends GoalAssociation {
  rootCommandId: string;
  rootPrincipalId: string;
  rootBinding: RuntimeMemberBinding;
  rootMode: 'do' | 'delegate';
  startedAt: string;
  deadlineAt: string;
  /** An observed expiry remains closed across wall-clock rollback until explicit extension. */
  deadlineReached?: boolean;
  attemptLimit: number;
  disposition: 'active' | 'finalizing' | 'accepted' | 'stopped';
  /** Counter and original input witnesses share one atomic OwnerState publication. No refunds. */
  debits: Record<string, { commandId: string; binding: RuntimeMemberBinding }>;
  proposal?: GoalProposal;
  published?: boolean;
  reason?: string;
  /** Original controls only, for immutable replay; bounded by the existing owner state limit. */
  controls?: Record<string, { fingerprint: string; result: GoalStatus }>;
  proposals?: Record<string, { fingerprint: string; result: GoalStatus }>;
}

export interface GoalStatus extends GoalAssociation {
  disposition: GoalRecord['disposition'];
  startedAt: string;
  deadlineAt: string;
  attemptLimit: number;
  attemptsUsed: number;
  reason?: string;
  resultMessageId?: string;
  published?: boolean;
  canResume?: boolean;
}

export interface GoalControl {
  commandId: string;
  goalId: string;
  expectedRevision: number;
  action: 'stop' | 'resume' | 'extend';
  deadlineAt?: string;
  attemptLimit?: number;
}

export interface GoalCommandPreparation {
  /** Trusted composition has just checked the actual current native Runtime. */
  intake?: { binding: RuntimeMemberBinding };
  source?: GoalInputSource;
  continuation?: GoalContinuation;
  result?: GoalAssociation;
}

export type ExecuteGoalCommand = (
  principalId: string,
  command: TeamCommand,
  preparation?: GoalCommandPreparation
) => CommandReceipt;

export type CapturedGoalInput = {
  source: GoalInputSource;
  intent: ImmutableDelivery;
};
