import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";
import {
  createSafeError,
  parseWorkspaceId,
  SystemClock,
  type Clock,
} from "@agent-teams-control-plane/shared";

import {
  assertTargetPolicySubjectKind,
  normalizeTargetPolicySubjectId,
  parseIntegrationTargetId,
} from "../../domain/integration-target.js";
import type {
  IntegrationTargetRepository,
  TargetPolicyEvaluationView,
} from "../ports/integration-target.repository.js";
import type {
  IntegrationTargetsFeatureGatePolicy,
  IntegrationTargetsSettings,
} from "../ports/policies.js";

export type EvaluateTargetPolicyInput = Readonly<{
  actor?: DesktopClientActor;
  workspaceId?: string;
  targetId: string;
  subjectKind: string;
  subjectId: string;
  capability: string;
  desktopClientSubjectId?: string;
  teamSubjectId?: string;
  agentSubjectId?: string;
}>;

export class EvaluateTargetPolicyUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
    private readonly settings: IntegrationTargetsSettings,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(
    input: EvaluateTargetPolicyInput,
  ): Promise<TargetPolicyEvaluationView> {
    await this.featureGate.assertEnabled("integration-targets");
    const subjectKind = assertTargetPolicySubjectKind(input.subjectKind);
    const subjectId = normalizeTargetPolicySubjectId({
      subjectId: input.subjectId,
      subjectKind,
    });
    const workspaceId = input.actor?.workspaceId ?? input.workspaceId;
    if (workspaceId === undefined) {
      throw createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_WORKSPACE_ID_REQUIRED",
        message: "Workspace id is required for target policy evaluation.",
      });
    }
    const parsedWorkspaceId =
      input.actor?.workspaceId === undefined ? parseWorkspaceId(workspaceId) : undefined;
    if (parsedWorkspaceId !== undefined && !parsedWorkspaceId.ok) {
      throw parsedWorkspaceId.error;
    }

    return this.repository.evaluatePolicy({
      capability: input.capability,
      subjectId,
      subjectKind,
      targetId: parseIntegrationTargetId(input.targetId),
      workspaceId: input.actor?.workspaceId ?? parsedWorkspaceId!.value,
      nowMs: this.clock.nowMs(),
      repositoryAvailabilityMaxAgeMs: this.settings.repositoryAvailabilityMaxAgeMs(),
      ...(input.agentSubjectId === undefined
        ? {}
        : { agentSubjectId: input.agentSubjectId }),
      ...buildDesktopClientSubject(input),
      ...(input.teamSubjectId === undefined
        ? {}
        : { teamSubjectId: input.teamSubjectId }),
    });
  }
}

function buildDesktopClientSubject(input: EvaluateTargetPolicyInput): {
  desktopClientSubjectId?: string;
} {
  const subjectId =
    input.desktopClientSubjectId ??
    (input.actor === undefined
      ? undefined
      : `desktop-client:${input.actor.desktopClientId}`);
  return subjectId === undefined ? {} : { desktopClientSubjectId: subjectId };
}
