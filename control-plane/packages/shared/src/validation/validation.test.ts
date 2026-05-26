import { describe, expect, it } from "vitest";

import { isErr, isOk } from "../result/result.js";

import { validationFailed, validationOk } from "./validation.js";

describe("validation helpers", () => {
  it("wraps valid values", () => {
    const result = validationOk({ id: "workspace-1" });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ id: "workspace-1" });
    }
  });

  it("wraps one or more validation issues", () => {
    const result = validationFailed({
      code: "required",
      message: "Workspace id is required.",
      path: ["workspaceId"],
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toEqual([
        {
          code: "required",
          message: "Workspace id is required.",
          path: ["workspaceId"],
        },
      ]);
    }
  });
});
