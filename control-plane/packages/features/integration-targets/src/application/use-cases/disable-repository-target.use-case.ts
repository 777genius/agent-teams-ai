import {
  createSafeError,
  SystemClock,
  type Clock,
} from "@agent-teams-control-plane/shared";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import { parseIntegrationTargetId } from "../../domain/integration-target.js";
import type {
  IntegrationTargetRepository,
  RepositoryTargetView,
} from "../ports/integration-target.repository.js";
import type {
  IntegrationTargetsAuditLog,
  IntegrationTargetsFeatureGatePolicy,
} from "../ports/policies.js";
import type { TransactionRunner } from "../ports/transaction-runner.js";

export type DisableRepositoryTargetInput = Readonly<{
  actor: DesktopClientActor;
  targetId: string;
  reason?: string;
}>;

export class DisableRepositoryTargetUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly transactionRunner: TransactionRunner,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
    private readonly auditLog: IntegrationTargetsAuditLog,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(
    input: DisableRepositoryTargetInput,
  ): Promise<RepositoryTargetView> {
    await this.featureGate.assertEnabled("integration-targets");
    const targetId = parseIntegrationTargetId(input.targetId);
    const reason = normalizeDisableReasonCode(input.reason);
    return this.transactionRunner.runInTransaction(async (context) => {
      const result = await this.repository.disableTarget(
        {
          nowMs: this.clock.nowMs(),
          targetId,
          workspaceId: input.actor.workspaceId,
          ...(reason === undefined ? {} : { reason }),
        },
        context,
      );

      await this.auditLog.record(
        {
          actor: input.actor,
          eventType: "integration_target.disabled",
          subjectId: result.target.id,
          subjectKind: "integration_target",
          safeMetadata: {
            reason: reason ?? null,
          },
        },
        context,
      );

      return result;
    });
  }
}

function normalizeDisableReasonCode(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  const normalized = reason.trim();
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(normalized)) {
    return normalized;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_TARGET_DISABLE_REASON_INVALID",
    message: "Repository target disable reason code is invalid.",
  });
}
