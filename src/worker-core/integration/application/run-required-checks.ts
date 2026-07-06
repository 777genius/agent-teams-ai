import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  markChecksRunning,
  recordCheckRuns,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import { IntegrationAuditEventType } from "../domain/integration-events";
import type { CheckRunnerPort } from "../ports/check-runner-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";

export type RunRequiredChecksDeps = IntegrationUseCaseDeps & {
  readonly checks: CheckRunnerPort;
};

export type RunRequiredChecksInput = {
  readonly attemptId: string;
};

export async function runRequiredChecks(
  deps: RunRequiredChecksDeps,
  input: RunRequiredChecksInput,
): Promise<IntegrationAttempt> {
  const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  if (
    attempt.status === IntegrationAttemptStatus.ChecksRunning ||
    attempt.status === IntegrationAttemptStatus.ChecksPassed
  ) {
    return attempt;
  }
  const startedAt = nowIso(deps.clock);
  const running = markChecksRunning(attempt, startedAt);
  await deps.store.update(running);
  await recordIntegrationAudit(deps, running, {
    type: IntegrationAuditEventType.ChecksStarted,
    occurredAt: startedAt,
  });

  const checkRuns = [];
  for (const check of running.reviewDecision.requiredChecks) {
    checkRuns.push(await deps.checks.runCheck({
      workspacePath: running.targetWorkspacePath,
      check,
      startedAt: nowIso(deps.clock),
    }));
  }

  const completedAt = nowIso(deps.clock);
  const updated = recordCheckRuns(running, {
    checkRuns,
    now: completedAt,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: updated.checkRuns.some((run) => run.status !== CheckRunStatus.Passed)
      ? IntegrationAuditEventType.ChecksFailed
      : IntegrationAuditEventType.ChecksPassed,
    occurredAt: completedAt,
  });
  return updated;
}
