import {
  isSafeError,
  parseIntegrationConnectionId,
  SystemClock,
  type Clock,
  type IntegrationConnectionId,
  type UnixMilliseconds,
} from "@agent-teams-control-plane/shared";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import {
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
  IntegrationTargetsSettings,
} from "../ports/policies.js";
import type { TransactionRunner } from "../ports/transaction-runner.js";

export type EnableRepositoryTargetInput = Readonly<{
  actor: DesktopClientActor;
  integrationConnectionId: string;
  githubRepositoryId: string;
  initialPolicyRules?: readonly TargetPolicyRuleInput[];
}>;

export class EnableRepositoryTargetUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly transactionRunner: TransactionRunner,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
    private readonly settings: IntegrationTargetsSettings,
    private readonly auditLog: IntegrationTargetsAuditLog,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(
    input: EnableRepositoryTargetInput,
  ): Promise<RepositoryTargetView> {
    await this.featureGate.assertEnabled("integration-targets");
    const initialPolicyRules = input.initialPolicyRules ?? [];
    const invalidPolicy = validateTargetPolicyRules(initialPolicyRules);
    if (invalidPolicy !== undefined) {
      throw invalidPolicy;
    }
    const integrationConnectionId = parseIntegrationConnectionId(
      input.integrationConnectionId,
    );
    if (!integrationConnectionId.ok) {
      throw integrationConnectionId.error;
    }

    return this.enableTargetInTransaction({
      actor: input.actor,
      githubRepositoryId: input.githubRepositoryId,
      initialPolicyRules,
      initialPolicyRulesProvided: input.initialPolicyRules !== undefined,
      integrationConnectionId: integrationConnectionId.value,
      nowMs: this.clock.nowMs(),
    });
  }

  private async enableTargetInTransaction(input: {
    actor: DesktopClientActor;
    integrationConnectionId: IntegrationConnectionId;
    githubRepositoryId: string;
    initialPolicyRules: readonly TargetPolicyRuleInput[];
    initialPolicyRulesProvided: boolean;
    nowMs: UnixMilliseconds;
  }): Promise<RepositoryTargetView> {
    try {
      return await this.transactionRunner.runInTransaction(async (context) => {
        const result = await this.repository.enableRepositoryTarget(
          {
            desktopClientId: input.actor.desktopClientId,
            githubRepositoryId: input.githubRepositoryId,
            initialPolicyRules: input.initialPolicyRules,
            initialPolicyRulesProvided: input.initialPolicyRulesProvided,
            integrationConnectionId: input.integrationConnectionId,
            nowMs: input.nowMs,
            repositoryAvailabilityMaxAgeMs:
              this.settings.repositoryAvailabilityMaxAgeMs(),
            workspaceId: input.actor.workspaceId,
          },
          context,
        );

        await this.auditLog.record(
          {
            actor: input.actor,
            eventType: "integration_target.enabled",
            subjectId: result.target.id,
            subjectKind: "integration_target",
            safeMetadata: {
              githubRepositoryId: result.binding.githubRepositoryId,
              integrationConnectionId: result.target.integrationConnectionId,
              policyRuleCount: result.policyRules.length,
            },
          },
          context,
        );

        return result;
      });
    } catch (error) {
      if (
        isSafeError(error) &&
        error.code === "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED"
      ) {
        await this.auditLog.record({
          actor: input.actor,
          eventType: "integration_target.repository_revalidation_required",
          subjectId: input.integrationConnectionId,
          subjectKind: "integration_connection",
          safeMetadata: {
            githubRepositoryId: input.githubRepositoryId,
            reasonCode: error.code,
          },
        });
      }
      throw error;
    }
  }
}
