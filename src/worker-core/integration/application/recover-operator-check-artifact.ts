import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  validateOperatorArtifactRecoveryAttempt,
  type OperatorArtifactRecoveryPermit,
} from "../domain/operator-artifact-recovery";
import {
  OperatorArtifactRecoveryState,
  type OperatorArtifactRecoveryPort,
  type OperatorArtifactRecoveryResult,
} from "../ports/operator-artifact-recovery-port";
import type { WorkspaceLockPort } from "../ports/workspace-lock-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type RecoverOperatorCheckArtifactDeps = IntegrationUseCaseDeps & {
  readonly recovery: OperatorArtifactRecoveryPort;
  readonly locks: WorkspaceLockPort;
};

export type RecoverOperatorCheckArtifactInput = {
  readonly permit: OperatorArtifactRecoveryPermit;
  readonly permitSha256: string;
  readonly confirm: boolean;
};

export async function recoverOperatorCheckArtifact(
  deps: RecoverOperatorCheckArtifactDeps,
  input: RecoverOperatorCheckArtifactInput,
): Promise<OperatorArtifactRecoveryResult> {
  const snapshot = await loadIntegrationAttempt(
    deps.store,
    input.permit.attemptId,
  );
  const previewValidation = validateOperatorArtifactRecoveryAttempt({
    attempt: snapshot,
    permit: input.permit,
  });
  if (!input.confirm) {
    return await deps.recovery.inspect({
      attempt: snapshot,
      permit: input.permit,
      permitSha256: input.permitSha256,
      validation: previewValidation,
    });
  }
  const lock = await deps.locks.acquire({
    workspacePath: snapshot.targetWorkspacePath,
    owner: `operator-artifact-recovery:${snapshot.attemptId}`,
  });
  try {
    const attempt = await loadIntegrationAttempt(
      deps.store,
      input.permit.attemptId,
    );
    if (attempt.targetWorkspacePath !== snapshot.targetWorkspacePath) {
      throw new Error("operator_artifact_recovery_workspace_changed");
    }
    const validation = validateOperatorArtifactRecoveryAttempt({
      attempt,
      permit: input.permit,
    });
    const inspected = await deps.recovery.inspect({
      attempt,
      permit: input.permit,
      permitSha256: input.permitSha256,
      validation,
    });
    if (inspected.state === OperatorArtifactRecoveryState.Completed) {
      await recordRecoveryAuditPair(
        deps,
        attempt,
        input.permitSha256,
        validation.artifactPath,
      );
      return inspected;
    }

    const preparedAt = nowIso(deps.clock);
    const prepared = await deps.recovery.prepare({
      attempt,
      permit: input.permit,
      permitSha256: input.permitSha256,
      validation,
      preparedAt,
    });
    await recordAuditOnce(deps, attempt, {
      type: IntegrationAuditEventType.OperatorArtifactRecoveryPrepared,
      occurredAt: preparedAt,
      permitSha256: input.permitSha256,
      files: [validation.artifactPath],
    });

    const completedAt = nowIso(deps.clock);
    const completed = await deps.recovery.complete({
      attempt,
      permit: input.permit,
      permitSha256: input.permitSha256,
      validation,
      completedAt,
    });
    await recordAuditOnce(deps, attempt, {
      type: IntegrationAuditEventType.OperatorArtifactRecoveryCompleted,
      occurredAt: completedAt,
      permitSha256: input.permitSha256,
      files: [validation.artifactPath],
    });
    return completed.state === OperatorArtifactRecoveryState.Completed
      ? completed
      : prepared;
  } finally {
    await deps.locks.release(lock);
  }
}

async function recordRecoveryAuditPair(
  deps: RecoverOperatorCheckArtifactDeps,
  attempt: Awaited<ReturnType<typeof loadIntegrationAttempt>>,
  permitSha256: string,
  artifactPath: string,
): Promise<void> {
  const occurredAt = nowIso(deps.clock);
  await recordAuditOnce(deps, attempt, {
    type: IntegrationAuditEventType.OperatorArtifactRecoveryPrepared,
    occurredAt,
    permitSha256,
    files: [artifactPath],
  });
  await recordAuditOnce(deps, attempt, {
    type: IntegrationAuditEventType.OperatorArtifactRecoveryCompleted,
    occurredAt,
    permitSha256,
    files: [artifactPath],
  });
}

async function recordAuditOnce(
  deps: RecoverOperatorCheckArtifactDeps,
  attempt: Awaited<ReturnType<typeof loadIntegrationAttempt>>,
  input: {
    readonly type: IntegrationAuditEventType;
    readonly occurredAt: string;
    readonly permitSha256: string;
    readonly files: readonly string[];
  },
): Promise<void> {
  const safeReason = `operator_artifact_recovery:${input.permitSha256}`;
  const events = deps.store.readEvents
    ? await deps.store.readEvents(attempt.attemptId)
    : [];
  if (
    events.some(
      (event) => event.type === input.type && event.safeReason === safeReason,
    )
  ) {
    return;
  }
  await recordIntegrationAudit(deps, attempt, {
    type: input.type,
    occurredAt: input.occurredAt,
    safeReason,
    files: input.files,
  });
}
