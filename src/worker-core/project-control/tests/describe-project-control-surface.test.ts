import { describe, expect, it } from "vitest";

import { describeProjectControlSurface } from "../index";

describe("describeProjectControlSurface", () => {
  it("declares broker and integration lifecycle tools without owning policy", () => {
    const surface = describeProjectControlSurface();

    expect(surface).toMatchObject({
      schemaVersion: 1,
      requiredBoundary: "project_scoped_control",
      childWorkerDefaultMode: "edit_test_handoff",
      policyOwner: "controller",
    });
    expect(surface.tools.map((tool) => tool.tool)).toEqual([
      "create_worktree",
      "create_job",
      "start_worker",
      "refill_worker",
      "prepare_verifier",
      "recover_operations",
      "mark_reviewed",
      "record_failed_no_output",
      "open_integration_attempt",
      "apply_worker_output",
      "run_required_checks",
      "commit_approved_changes",
      "push_approved_commit",
    ]);
    expect(surface.tools.every((tool) =>
      tool.requiredBoundary === "project_scoped_control" &&
      tool.policyOwner === "controller"
    )).toBe(true);
  });

  it("keeps shared workspace writes inside the integration lifecycle", () => {
    const surface = describeProjectControlSurface();
    const writerTools = surface.tools
      .filter((tool) => tool.writesSharedWorkspace)
      .map((tool) => tool.tool);

    expect(writerTools).toEqual([
      "apply_worker_output",
      "commit_approved_changes",
      "push_approved_commit",
    ]);
    expect(surface.integrationSequence).toEqual([
      "open_integration_attempt",
      "apply_worker_output",
      "run_required_checks",
      "commit_approved_changes",
      "push_approved_commit",
    ]);
  });
});
