import type {
  AgentErrorMetadataV1 as SharedAgentErrorMetadataV1,
  RuntimeRecoveryNudgeMetadataV1 as SharedRuntimeRecoveryNudgeMetadataV1,
  RuntimeRecoveryReasonCode,
} from '@shared/types';

export type TeamRuntimeRecoveryTargetKind = 'lead' | 'member';

export type TeamRuntimeRecoveryProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';

export type RuntimeFailurePhase = 'sdk_retrying' | 'terminal';

export type RuntimeFailureSource =
  | 'lead_stream'
  | 'agent_error_mailbox'
  | 'member_runtime_advisory'
  | 'legacy_message_scan';

export type RuntimeFailureReasonCode = RuntimeRecoveryReasonCode;

export interface TeamRuntimeRecoveryTaskRef {
  taskId: string;
  displayId?: string;
  teamName?: string;
}

export interface RuntimeFailureSignal {
  id: string;
  source: RuntimeFailureSource;
  phase: RuntimeFailurePhase;
  observedAt: string;
  contextId: string;
  teamName: string;
  memberName: string;
  targetKind: TeamRuntimeRecoveryTargetKind;
  detail: string;
  statusCode?: number;
  providerCode?: string;
  retryAfterMs?: number;
  resetAt?: string;
  runId?: string;
  runtimeSessionId?: string;
  providerId?: TeamRuntimeRecoveryProviderId;
  providerBackendId?: string;
  model?: string;
  sourceMessageId?: string;
  failedMessageId?: string;
  causedByRecoveryMessageId?: string;
  innerRecoveryAttempts?: number;
  taskRefs?: TeamRuntimeRecoveryTaskRef[];
}

export type AgentErrorMetadataV1 = SharedAgentErrorMetadataV1;
export type RuntimeRecoveryNudgeMetadataV1 = SharedRuntimeRecoveryNudgeMetadataV1;

export interface TeamRuntimeRecoveryConfig {
  transientErrorsEnabled: boolean;
  rateLimitsEnabled: boolean;
  initialDelaySeconds: number;
  maxAttempts: number;
}

export const DEFAULT_TEAM_RUNTIME_RECOVERY_CONFIG: TeamRuntimeRecoveryConfig = {
  transientErrorsEnabled: false,
  rateLimitsEnabled: false,
  initialDelaySeconds: 60,
  maxAttempts: 2,
};

export const TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MIN_SECONDS = 15;
export const TEAM_RUNTIME_RECOVERY_INITIAL_DELAY_MAX_SECONDS = 900;
export const TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MIN = 1;
export const TEAM_RUNTIME_RECOVERY_MAX_ATTEMPTS_MAX = 5;

export type RuntimeRecoveryJobStatus =
  | 'pending'
  | 'claimed'
  | 'awaiting_outcome'
  | 'completed'
  | 'superseded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown'
  | 'cancelled';

export type RuntimeRecoveryCircuitStatus = 'open' | 'half_open' | 'closed';
