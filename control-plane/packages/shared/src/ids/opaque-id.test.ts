import { describe, expect, it } from "vitest";

import { isErr, isOk } from "../result/result.js";

import {
  parseAgentActionId,
  parseWorkspaceId,
  type AgentActionId,
  type WorkspaceId,
} from "./opaque-id.js";

describe("opaque IDs", () => {
  it("parses non-empty strings and normalizes surrounding whitespace", () => {
    const result = parseWorkspaceId(" workspace-1 ");

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe("workspace-1");
    }
  });

  it("rejects empty inputs with a safe validation error", () => {
    const result = parseWorkspaceId("   ");

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toMatchObject({
        category: "validation",
        code: "CONTROL_PLANE_INVALID_OPAQUE_ID",
        safeDetails: { kind: "WorkspaceId" },
      });
    }
  });

  it("keeps ID types separated at compile time", () => {
    const workspace = requireOk(parseWorkspaceId("workspace-1"));
    const action = requireOk(parseAgentActionId("action-1"));

    const acceptWorkspace = (id: WorkspaceId): WorkspaceId => id;
    const acceptAction = (id: AgentActionId): AgentActionId => id;

    expect(acceptWorkspace(workspace)).toBe("workspace-1");
    expect(acceptAction(action)).toBe("action-1");
  });
});

function requireOk<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) {
    throw new Error("Expected ok result.");
  }
  return result.value;
}
