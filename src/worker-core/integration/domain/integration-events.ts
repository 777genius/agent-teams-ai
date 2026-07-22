import type { IntegrationAttemptStatus } from "./integration-attempt";

export enum IntegrationAuditEventType {
  AttemptOpened = "integration_attempt.opened",
  AttemptApplied = "integration_attempt.applied",
  ChecksStarted = "integration_attempt.check_started",
  ChecksPassed = "integration_attempt.check_passed",
  ChecksFailed = "integration_attempt.check_failed",
  OperatorArtifactRecoveryPrepared = "integration_attempt.operator_artifact_recovery_prepared",
  OperatorArtifactRecoveryCompleted = "integration_attempt.operator_artifact_recovery_completed",
  CommitCreated = "integration_attempt.commit_created",
  Pushed = "integration_attempt.pushed",
  Promoted = "integration_attempt.promoted",
  Rejected = "integration_attempt.rejected",
  PolicyDenied = "integration_attempt.policy_denied",
}

export type IntegrationAuditEvent = {
  readonly schemaVersion: 1;
  readonly type: IntegrationAuditEventType;
  readonly occurredAt: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId?: string;
  readonly status?: IntegrationAttemptStatus;
  readonly safeReason?: string;
  readonly files?: readonly string[];
  readonly commitSha?: string;
};
