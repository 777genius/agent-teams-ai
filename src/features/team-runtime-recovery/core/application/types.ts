import type {
  RuntimeFailureReasonCode,
  RuntimeFailureSignal,
  RuntimeRecoveryCircuitStatus,
  RuntimeRecoveryJobStatus,
} from '../../contracts';

export interface RuntimeRecoveryJob {
  id: string;
  signal: RuntimeFailureSignal;
  reasonCode: RuntimeFailureReasonCode;
  normalizedDetailHash: string;
  circuitKey: string;
  status: RuntimeRecoveryJobStatus;
  attempt: number;
  nextAttemptAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimedAt?: string;
  recoveryMessageId?: string;
  lastError?: string;
  outcomeDeadlineAt?: string;
}

export interface RuntimeRecoveryCircuit {
  key: string;
  status: RuntimeRecoveryCircuitStatus;
  consecutiveFailures: number;
  nextProbeAt: string;
  activeProbeJobId?: string;
  updatedAt: string;
}

export interface RuntimeRecoveryTeamState {
  schemaVersion: 1;
  teamName: string;
  jobs: RuntimeRecoveryJob[];
  circuits: RuntimeRecoveryCircuit[];
  processedSignalIds: string[];
  updatedAt: string;
}

export type RuntimeRecoveryPreflightResult =
  | {
      ok: true;
      currentRunId?: string;
      currentRuntimeSessionId?: string;
      memberName: string;
      targetKind: RuntimeFailureSignal['targetKind'];
      providerId?: RuntimeFailureSignal['providerId'];
      providerBackendId?: string;
      model?: string;
    }
  | {
      ok: false;
      reason: string;
      retryable: boolean;
      retryAt?: string;
      escalateToLead?: boolean;
      leadName?: string;
    };

export type RuntimeRecoveryDeliveryResult =
  | {
      ok: true;
      messageId: string;
      accepted: boolean;
      responseProven?: boolean;
    }
  | {
      ok: false;
      reason: string;
      retryable: boolean;
      retryAt?: string;
    };
