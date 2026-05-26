import {
  createSafeError,
  SystemClock,
  type Clock,
} from "@agent-teams-control-plane/shared";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import {
  parseIntegrationTargetId,
  validateTargetPolicyRules,
  type TargetPolicyRuleInput,
} from "../../domain/integration-target.js";
import type {
  IntegrationTargetRepository,
  RepositoryTargetView,
} from "../ports/integration-target.repository.js";
import type {
  IntegrationTargetsAuditLog,
  IntegrationTargetsFeatureGatePolicy,
} from "../ports/policies.js";
import type { TransactionRunner } from "../ports/transaction-runner.js";

export type UpdateTargetPolicyInput = Readonly<{
  actor: DesktopClientActor;
  targetId: string;
  expectedPolicyVersion: number;
  policyRules: readonly TargetPolicyRuleInput[];
}>;

export class UpdateTargetPolicyUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly transactionRunner: TransactionRunner,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
    private readonly auditLog: IntegrationTargetsAuditLog,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(input: UpdateTargetPolicyInput): Promise<RepositoryTargetView> {
    await this.featureGate.assertEnabled("integration-targets");
    if (
      !Number.isInteger(input.expectedPolicyVersion) ||
      input.expectedPolicyVersion <= 0
    ) {
      throw createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_TARGET_POLICY_VERSION_INVALID",
        message: "Target policy version is invalid.",
      });
    }
    const invalidPolicy = validateTargetPolicyRules(input.policyRules);
    if (invalidPolicy !== undefined) {
      throw invalidPolicy;
    }

    return this.transactionRunner.runInTransaction(async (context) => {
      const result = await this.repository.replacePolicy(
        {
          desktopClientId: input.actor.desktopClientId,
          expectedPolicyVersion: input.expectedPolicyVersion,
          nowMs: this.clock.nowMs(),
          policyRules: input.policyRules,
          targetId: parseIntegrationTargetId(input.targetId),
          workspaceId: input.actor.workspaceId,
        },
        context,
      );

      await this.auditLog.record(
        {
          actor: input.actor,
          eventType: "integration_target.policy_replaced",
          subjectId: result.target.id,
          subjectKind: "integration_target",
          safeMetadata: {
            policyRuleCount: result.policyRules.length,
            policyVersion: result.target.policyVersion,
          },
        },
        context,
      );

      return result;
    });
  }
}
