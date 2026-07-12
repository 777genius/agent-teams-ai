import {
  IntegrationAttemptStatus,
  markRejected,
  type IntegrationAttempt,
} from "../domain/integration-attempt";
import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  type IntegrationUseCaseDeps,
} from "./common";
import type {
  IntegratedOutputLedgerPort,
  RejectedOutputLedgerReceipt,
} from "../ports/integrated-output-ledger-port";

export type RejectIntegrationAttemptInput = {
  readonly attemptId: string;
  readonly reason: string;
};

export async function rejectIntegrationAttempt(
  deps: IntegrationUseCaseDeps & {
    readonly integratedOutputLedger: IntegratedOutputLedgerPort;
  },
  input: RejectIntegrationAttemptInput,
): Promise<IntegrationAttempt & {
  readonly consumedOutputLedger: RejectedOutputLedgerReceipt;
}> {
  const attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  const preparation = await deps.integratedOutputLedger.prepareRejection({
    attempt,
  });
  if (attempt.status === IntegrationAttemptStatus.Rejected) {
    const consumedOutputLedger = await deps.integratedOutputLedger.finalizeRejection({
      preparation,
      rejectedAt: attempt.updatedAt,
      reason: attempt.rejectReason ?? input.reason,
    });
    return { ...attempt, consumedOutputLedger };
  }
  const now = nowIso(deps.clock);
  const updated = markRejected(attempt, {
    reason: input.reason,
    now,
  });
  const consumedOutputLedger = await deps.integratedOutputLedger.finalizeRejection({
    preparation,
    rejectedAt: now,
    reason: input.reason,
  });
  await deps.store.update(updated);
  await recordIntegrationAudit(deps, updated, {
    type: IntegrationAuditEventType.Rejected,
    occurredAt: now,
    safeReason: input.reason,
  });
  return { ...updated, consumedOutputLedger };
}
