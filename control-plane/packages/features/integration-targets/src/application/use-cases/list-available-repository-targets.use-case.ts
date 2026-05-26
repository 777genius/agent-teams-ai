import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";
import { parseIntegrationConnectionId } from "@agent-teams-control-plane/shared";

import { assertIntegrationTargetStatus } from "../../domain/integration-target.js";
import type {
  AvailableRepositoryTargetsView,
  IntegrationTargetRepository,
} from "../ports/integration-target.repository.js";
import type { IntegrationTargetsFeatureGatePolicy } from "../ports/policies.js";
import {
  normalizeRepositoryTargetPagination,
  type RepositoryTargetPaginationInput,
} from "./repository-target-pagination.js";

export type ListAvailableRepositoryTargetsInput = Readonly<{
  actor: DesktopClientActor;
  integrationConnectionId: string;
  filters?: {
    available?: boolean;
    archived?: boolean;
    targetStatus?: string;
  };
  pagination?: RepositoryTargetPaginationInput;
}>;

export class ListAvailableRepositoryTargetsUseCase {
  public constructor(
    private readonly repository: IntegrationTargetRepository,
    private readonly featureGate: IntegrationTargetsFeatureGatePolicy,
  ) {}

  public async execute(
    input: ListAvailableRepositoryTargetsInput,
  ): Promise<AvailableRepositoryTargetsView> {
    await this.featureGate.assertEnabled("integration-targets");
    const integrationConnectionId = parseIntegrationConnectionId(
      input.integrationConnectionId,
    );
    if (!integrationConnectionId.ok) {
      throw integrationConnectionId.error;
    }
    const filters = normalizeFilters(input.filters);
    const pagination = normalizeRepositoryTargetPagination(input.pagination);
    return this.repository.listAvailableRepositories({
      integrationConnectionId: integrationConnectionId.value,
      workspaceId: input.actor.workspaceId,
      ...(filters === undefined ? {} : { filters }),
      ...(pagination === undefined ? {} : { pagination }),
    });
  }
}

function normalizeFilters(
  filters: ListAvailableRepositoryTargetsInput["filters"],
): ListAvailableRepositoryTargetsInput["filters"] {
  if (filters?.targetStatus === undefined) {
    return filters;
  }
  return {
    ...filters,
    targetStatus: assertIntegrationTargetStatus(filters.targetStatus),
  };
}
