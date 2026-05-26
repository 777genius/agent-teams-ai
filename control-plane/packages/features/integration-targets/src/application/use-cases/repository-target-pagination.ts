import { createSafeError } from "@agent-teams-control-plane/shared";

import type { RepositoryTargetPagination } from "../ports/integration-target.repository.js";

export type RepositoryTargetPaginationInput = Readonly<{
  limit?: number;
  offset?: number;
}>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export function normalizeRepositoryTargetPagination(
  input: RepositoryTargetPaginationInput | undefined,
): RepositoryTargetPagination | undefined {
  if (input === undefined || (input.limit === undefined && input.offset === undefined)) {
    return undefined;
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_REPOSITORY_TARGET_PAGINATION_INVALID",
      message: "Repository target pagination limit is invalid.",
      safeDetails: { field: "limit", max: MAX_LIMIT, min: 1 },
    });
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_REPOSITORY_TARGET_PAGINATION_INVALID",
      message: "Repository target pagination offset is invalid.",
      safeDetails: { field: "offset", min: 0 },
    });
  }

  return { limit, offset };
}
