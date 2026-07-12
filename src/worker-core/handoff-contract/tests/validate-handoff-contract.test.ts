import { describe, expect, it } from "vitest";

import { validateHandoffContract } from "../index";

describe("validateHandoffContract", () => {
  it("does not require handoff artifacts for clean no-diff workers", () => {
    expect(validateHandoffContract({
      workerJobId: "job-clean",
      workspacePath: "/work/job-clean",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: false,
      changedFiles: [],
    })).toMatchObject({
      status: "not_required",
      issues: [],
    });
  });

  it("blocks dirty linked-worktree-style handoffs without patch or summary", () => {
    expect(validateHandoffContract({
      workerJobId: "job-dirty",
      workspacePath: "/work/job-dirty",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
    })).toMatchObject({
      status: "invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "handoff_artifact_missing" }),
      ]),
    });
  });

  it("warns when patch exists but base commit is missing", () => {
    expect(validateHandoffContract({
      workerJobId: "job-patch",
      workspacePath: "/work/job-patch",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
      patchPath: "/work/job-patch/.codex-handoff/job-patch.patch",
    })).toMatchObject({
      status: "unknown",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "base_commit_missing" }),
      ]),
    });
  });

  it("accepts patch handoffs with a base commit", () => {
    expect(validateHandoffContract({
      workerJobId: "job-valid",
      workspacePath: "/work/job-valid",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
      baseCommit: "abc123",
      patchPath: ".codex-handoff/job-valid.patch",
      checks: [{ checkId: "focused-tests", status: "passed" }],
    })).toMatchObject({
      status: "valid",
      issues: [],
    });
  });

  it("accepts hashed artifacts owned by the worker job root", () => {
    expect(validateHandoffContract({
      workerJobId: "job-valid-root",
      workspacePath: "/work/job-valid-root",
      artifactRootPath: "/jobs/job-valid-root",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
      baseCommit: "abc123",
      patchPath: "/jobs/job-valid-root/task.handoff.patch",
      summaryPath: "/jobs/job-valid-root/task.handoff.summary.json",
      manifestPath: "/jobs/job-valid-root/task.handoff.manifest.json",
      manifestSha256: "a".repeat(64),
    })).toMatchObject({
      status: "valid",
      issues: [],
    });
  });

  it("rejects artifact paths outside the worker workspace", () => {
    expect(validateHandoffContract({
      workerJobId: "job-escape",
      workspacePath: "/work/job-escape",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
      baseCommit: "abc123",
      patchPath: "/work/other/job.patch",
    })).toMatchObject({
      status: "invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "handoff_path_outside_workspace" }),
      ]),
    });
  });

  it("blocks failed handoff checks", () => {
    expect(validateHandoffContract({
      workerJobId: "job-failed-check",
      workspacePath: "/work/job-failed-check",
      createdAt: "2026-07-05T00:00:00.000Z",
      workspaceDirty: true,
      changedFiles: ["src/file.ts"],
      baseCommit: "abc123",
      patchPath: ".codex-handoff/job.patch",
      checks: [{ checkId: "typecheck", status: "failed" }],
    })).toMatchObject({
      status: "invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "handoff_check_failed" }),
      ]),
    });
  });
});
