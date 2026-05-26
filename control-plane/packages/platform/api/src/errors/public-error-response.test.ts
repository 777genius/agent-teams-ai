import { describe, expect, it } from "vitest";

import { createSafeError } from "@agent-teams-control-plane/shared";

import {
  createPublicErrorResponse,
  getHttpStatusForSafeError,
} from "./public-error-response.js";

describe("public error response", () => {
  it("serializes only the safe public error contract", () => {
    const safeError = createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_TEST_VALIDATION",
      message: "Validation failed.",
      safeDetails: { field: "workspaceId" },
    });

    expect(
      createPublicErrorResponse({
        correlationId: "correlation-1",
        safeError,
      }),
    ).toEqual({
      error: {
        category: "validation",
        code: "CONTROL_PLANE_TEST_VALIDATION",
        correlationId: "correlation-1",
        message: "Validation failed.",
        retryable: false,
        safeDetails: { field: "workspaceId" },
      },
    });
  });

  it("maps safe error categories to public HTTP statuses", () => {
    expect(
      getHttpStatusForSafeError(
        createSafeError({
          category: "validation",
          code: "INVALID",
          message: "Invalid.",
        }),
      ),
    ).toBe(400);
    expect(
      getHttpStatusForSafeError(
        createSafeError({
          category: "external",
          code: "UPSTREAM_UNAVAILABLE",
          message: "Upstream unavailable.",
          retryable: true,
        }),
      ),
    ).toBe(503);
  });
});
