import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  CheckWorkspaceIntegrityDisposition,
  IntegrationAttemptStatus,
  allCheckRunsPassed,
  integrationAppliedFiles,
  markChecksRunning,
  recordCheckRuns,
  type CheckRun,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import {
  IntegrationError,
  IntegrationErrorReason,
} from "../domain/integration-errors";
import { IntegrationAuditEventType } from "../domain/integration-events";
import type { CheckRunnerPort } from "../ports/check-runner-port";
import type { WorkspaceLockPort } from "../ports/workspace-lock-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type RunRequiredChecksDeps = IntegrationUseCaseDeps & {
  readonly checks: CheckRunnerPort;
  readonly locks: WorkspaceLockPort;
};

export type RunRequiredChecksInput = {
  readonly attemptId: string;
};

export async function runRequiredChecks(
  deps: RunRequiredChecksDeps,
  input: RunRequiredChecksInput,
): Promise<IntegrationAttempt> {
  const snapshot = await loadIntegrationAttempt(deps.store, input.attemptId);
  const lock = await deps.locks.acquire({
    workspacePath: snapshot.targetWorkspacePath,
    owner: snapshot.attemptId,
  });
  try {
    const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
    assertSameTargetWorkspace(snapshot, attempt);
    return await runRequiredChecksLocked(deps, attempt);
  } finally {
    await deps.locks.release(lock);
  }
}

async function runRequiredChecksLocked(
  deps: RunRequiredChecksDeps,
  attempt: IntegrationAttempt,
): Promise<IntegrationAttempt> {
  if (requiredChecksAlreadyPassed(attempt)) {
    return attempt;
  }
  const startedAt = nowIso(deps.clock);
  const running = markChecksRunning(attempt, startedAt);
  await deps.store.update(running);
  await recordIntegrationAudit(deps, running, {
    type: IntegrationAuditEventType.ChecksStarted,
    occurredAt: startedAt,
  });

  const checkRuns = await runDeclaredRequiredChecks(deps, running);

  const completedAt = nowIso(deps.clock);
  const updated = recordCheckRuns(running, {
    checkRuns,
    now: completedAt,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: auditEventTypeForCheckRuns(updated.checkRuns),
    occurredAt: completedAt,
  });
  return updated;
}

function assertSameTargetWorkspace(
  snapshot: IntegrationAttempt,
  current: IntegrationAttempt,
): void {
  if (snapshot.targetWorkspacePath !== current.targetWorkspacePath) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      evidence: ["integration_attempt_target_workspace_changed"],
    });
  }
}

function requiredChecksAlreadyPassed(attempt: IntegrationAttempt): boolean {
  return attempt.status === IntegrationAttemptStatus.ChecksPassed;
}

async function runDeclaredRequiredChecks(
  deps: RunRequiredChecksDeps,
  attempt: IntegrationAttempt,
): Promise<readonly CheckRun[]> {
  const checkRuns: CheckRun[] = [];
  for (const check of attempt.reviewDecision.requiredChecks) {
    const run = await deps.checks.runCheck({
      workspacePath: attempt.targetWorkspacePath,
      allowedWorkspaceFiles: integrationAppliedFiles(attempt),
      check: rebaseReviewedCheckCwd(attempt, check),
      startedAt: nowIso(deps.clock),
    });
    checkRuns.push(run);
    if (
      run.workspaceIntegrity !== undefined &&
      run.workspaceIntegrity !== CheckWorkspaceIntegrityDisposition.Unchanged
    ) {
      break;
    }
  }
  return checkRuns;
}

function rebaseReviewedCheckCwd(
  attempt: IntegrationAttempt,
  check: IntegrationAttempt["reviewDecision"]["requiredChecks"][number],
): IntegrationAttempt["reviewDecision"]["requiredChecks"][number] {
  if (check.cwd === undefined || !isAbsolute(check.cwd)) return check;

  const sourceWorkspace = resolve(attempt.sourceWorkspacePath);
  const relativeCwd = relative(sourceWorkspace, resolve(check.cwd));
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${sep}`) ||
    isAbsolute(relativeCwd)
  )
    return check;

  return {
    ...check,
    cwd: relativeCwd === "" ? "." : relativeCwd,
  };
}

function auditEventTypeForCheckRuns(
  checkRuns: readonly CheckRun[],
):
  | IntegrationAuditEventType.ChecksFailed
  | IntegrationAuditEventType.ChecksPassed {
  return allCheckRunsPassed(checkRuns)
    ? IntegrationAuditEventType.ChecksPassed
    : IntegrationAuditEventType.ChecksFailed;
}
