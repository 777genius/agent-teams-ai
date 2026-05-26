import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import { assertIntegrationTargetStatus } from "../../domain/integration-target.js";
import type {
  IntegrationTargetRepository,
  RepositoryTargetView,
} from "../ports/integration-target.repository.js";
import type { IntegrationTargetsFeatureGatePolicy } from "../ports/policies.js";
import {
  normalizeRepositoryTargetPagination,
  type RepositoryTargetPaginationInput,
} from "./repository-target-pagination.js";

export type ListRepositoryTargetsInput = Readonly<{
  actor: DesktopClientActor;
  status?: string;
  pagination?: RepositoryTargetPaginationInput;
}>;

export class ListRepositoryTargetsUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
  ) {}

  public async execute(
    input: ListRepositoryTargetsInput,
  ): Promise<readonly RepositoryTargetView[]> {
    await this.featureGate.assertEnabled("integration-targets");
    const status =
      input.status === undefined
        ? undefined
        : assertIntegrationTargetStatus(input.status);
    const pagination = normalizeRepositoryTargetPagination(input.pagination);
    return this.repository.listTargets({
      workspaceId: input.actor.workspaceId,
      ...(status === undefined ? {} : { status }),
      ...(pagination === undefined ? {} : { pagination }),
    });
  }
}
