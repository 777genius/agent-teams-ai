import { createSafeError } from "@agent-teams-control-plane/shared";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import { parseIntegrationTargetId } from "../../domain/integration-target.js";
import type {
  IntegrationTargetRepository,
  RepositoryTargetView,
} from "../ports/integration-target.repository.js";
import type { IntegrationTargetsFeatureGatePolicy } from "../ports/policies.js";

export type GetRepositoryTargetInput = Readonly<{
  actor: DesktopClientActor;
  targetId: string;
}>;

export class GetRepositoryTargetUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
  ) {}

  public async execute(input: GetRepositoryTargetInput): Promise<RepositoryTargetView> {
    await this.featureGate.assertEnabled("integration-targets");
    const target = await this.repository.findTarget({
      targetId: parseIntegrationTargetId(input.targetId),
      workspaceId: input.actor.workspaceId,
    });
    if (target === undefined) {
      throw createSafeError({
        category: "not-found",
        code: "CONTROL_PLANE_TARGET_NOT_FOUND",
        message: "Repository target was not found.",
      });
    }
    return target;
  }
}
