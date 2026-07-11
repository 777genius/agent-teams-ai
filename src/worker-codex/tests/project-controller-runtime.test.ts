import { describe, expect, it } from "vitest";
import { projectControllerProcessOwner } from "../application/project-control/codex-goal-project-controller-runtime";

describe("project controller runtime", () => {
  it("keeps one owner identity for every controller operation in the process", () => {
    const first = projectControllerProcessOwner("test-runtime");
    const second = projectControllerProcessOwner("test-runtime");

    expect(second).toBe(first);
    expect(second.ownerId).toBe(first.ownerId);
    expect(second.pid).toBe(process.pid);
  });
});
