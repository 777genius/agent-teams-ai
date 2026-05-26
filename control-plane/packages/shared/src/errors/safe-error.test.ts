import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_INTERNAL_ERROR,
  createSafeError,
  isSafeError,
  toSafeError,
} from "./safe-error.js";

describe("SafeError", () => {
  it("creates a stable safe error with primitive safe details only", () => {
    const safeError = createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_INVALID_INPUT",
      message: "Invalid input.",
      safeDetails: {
        field: "workspaceId",
        retryAfterSeconds: 0,
      },
    });

    expect(safeError).toEqual({
      category: "validation",
      code: "CONTROL_PLANE_INVALID_INPUT",
      message: "Invalid input.",
      retryable: false,
      safeDetails: {
        field: "workspaceId",
        retryAfterSeconds: 0,
      },
    });
    expect(isSafeError(safeError)).toBe(true);
  });

  it("keeps an existing SafeError unchanged", () => {
    const safeError = createSafeError({
      category: "external",
      code: "GITHUB_RATE_LIMITED",
      message: "GitHub rate limit reached.",
      retryable: true,
    });

    expect(toSafeError(safeError)).toEqual(safeError);
  });

  it("drops extra fields from SafeError-shaped objects", () => {
    const safeError = toSafeError({
      category: "internal",
      code: "CONTROL_PLANE_INTERNAL_ERROR",
      message: "Internal control-plane error.",
      retryable: false,
      stack: "secret stack",
    });

    expect(safeError).toEqual({
      category: "internal",
      code: "CONTROL_PLANE_INTERNAL_ERROR",
      message: "Internal control-plane error.",
      retryable: false,
    });
    expect(JSON.stringify(safeError)).not.toContain("secret stack");
  });

  it("rejects unsafe nested details at creation time", () => {
    expect(() =>
      createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_INVALID_INPUT",
        message: "Invalid input.",
        safeDetails: { nested: ["not-safe"] } as never,
      }),
    ).toThrow(TypeError);
  });

  it("converts unknown errors to a non-leaky internal fallback", () => {
    const safeError = toSafeError(new Error("database password leaked in stack"));

    expect(safeError).toEqual({
      category: "internal",
      code: CONTROL_PLANE_INTERNAL_ERROR,
      message: "Internal control-plane error.",
      retryable: false,
    });
    expect(JSON.stringify(safeError)).not.toContain("database password");
  });
});
