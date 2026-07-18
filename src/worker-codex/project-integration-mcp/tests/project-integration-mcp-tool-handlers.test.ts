import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ReviewDecisionStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createProjectIntegrationMcpToolHandlers,
  type ProjectIntegrationMcpController,
} from "../index";
import { reviewedWorkerOutputFormat } from "../../reviewed-worker-output";
import { createFixture } from "../../../worker-core/integration/tests/project-integration-use-cases.fixture";

const controller: ProjectIntegrationMcpController = {
  registryRootDir: "/registry",
  controller: {
    jobId: "controller-1",
    jobRootDir: "/jobs/controller-1",
  },
  scope: {
    projectId: "project-1",
    workspaceRoots: ["/target"],
    allowForcePush: true,
  },
};

describe("project integration MCP tool handlers", () => {
  it("builds open-attempt previews in the feature slice without invoking use cases", async () => {
    let integrationDepsCalls = 0;
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string")
          throw new Error(`${fieldName} is required`);
        return `/resolved/${value}`;
      },
      integrationDeps: () => {
        integrationDepsCalls += 1;
        throw new Error("integration_deps_unexpected");
      },
    });

    const result = await handlers.openAttempt({
      controllerJobId: "controller-1",
      attemptId: "attempt-1",
      workerJobId: "worker-1",
      workerWorkspacePath: "worker",
      targetWorkspacePath: "target",
      targetBranch: "feature/project",
      workerCommitSha: "abcdef1",
      workerBaseCommit: "1234567",
      targetCommit: "7654321",
      baseStatus: "current",
      baseRevisionReasons: "base-current",
      changedFiles: "src/worker-codex/project-integration-mcp/index.ts",
      allowedPathPrefixes: "src/worker-codex/project-integration-mcp/",
      requiredCheckIds: "unit",
      requiredChecks: [
        {
          checkId: "unit",
          command: ["npm", "test"],
          timeoutMs: 30_000,
        },
      ],
      allowStaleBase: true,
    });

    expect(integrationDepsCalls).toBe(0);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      reason: "confirm_open_required",
      mode: "project_integration_open_attempt",
      controllerJobId: "controller-1",
      attemptId: "attempt-1",
    });

    const preview = body.attemptPreview as Record<string, unknown>;
    expect(preview).toMatchObject({
      policy: {
        access: {
          boundary: AccessBoundary.ProjectScopedControl,
          scope: {
            projectId: "project-1",
            allowForcePush: true,
          },
        },
        allowedPathPrefixes: ["src/worker-codex/project-integration-mcp/"],
        requiredCheckIds: ["unit"],
        allowForcePush: true,
        allowStaleBase: true,
      },
      projectId: "project-1",
      sourceWorkspacePath: "/resolved/worker",
      targetWorkspacePath: "/resolved/target",
      targetBranch: "feature/project",
      targetRemote: "origin",
      workerOutput: {
        workerJobId: "worker-1",
        workspacePath: "/resolved/worker",
        commitSha: "abcdef1",
        baseCommit: "1234567",
        targetCommit: "7654321",
        baseStatus: "current",
        baseRevisionReasons: ["base-current"],
        changedFiles: ["src/worker-codex/project-integration-mcp/index.ts"],
      },
      reviewDecision: {
        reviewedBy: "controller-1",
        decision: ReviewDecisionStatus.Approved,
        reason: "project_integration_reviewed",
        approvedFiles: ["src/worker-codex/project-integration-mcp/index.ts"],
        requiredChecks: [
          {
            checkId: "unit",
            command: ["npm", "test"],
            timeoutMs: 30_000,
          },
        ],
      },
    });
  });

  it("keeps integration argument validation owned by the feature slice", async () => {
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string")
          throw new Error(`${fieldName} is required`);
        return value;
      },
      integrationDeps: () => {
        throw new Error("integration_deps_unexpected");
      },
    });

    await expect(
      handlers.openAttempt({
        attemptId: "attempt-1",
        workerJobId: "worker-1",
        workerWorkspacePath: "worker",
        targetWorkspacePath: "target",
        targetBranch: "feature/project",
        workerCommitSha: "abcdef1",
        baseStatus: "bad",
        changedFiles: ["src/file.ts"],
      }),
    ).rejects.toThrow("project_integration_base_status_invalid");
  });

  it("resolves immutable reviewed output without duplicating source arguments", async () => {
    const reviewedOutputId = "a".repeat(64);
    const patchSha256 = "b".repeat(64);
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string")
          throw new Error(`${fieldName} is required`);
        return `/resolved/${value}`;
      },
      resolveReviewedOutput: async () => ({
        snapshot: {
          format: reviewedWorkerOutputFormat,
          formatRevision: 1,
          reviewedOutputId,
          projectId: "project-1",
          controllerJobId: "controller-1",
          workerJobId: "worker-1",
          taskId: "task-1",
          sourceWorkspacePath: "/worker",
          patchPath: "/evidence/output.patch",
          patchSha256,
          patchByteLength: 100,
          baseCommit: "1".repeat(40),
          changedFiles: ["src/file.ts"],
          reviewDecision: {
            reviewedBy: "controller-1",
            decision: ReviewDecisionStatus.Approved,
            reason: "review accepted",
            approvedFiles: ["src/file.ts"],
            requiredChecks: [{ checkId: "unit", command: ["npm", "test"] }],
          },
          capturedAt: "2026-07-13T00:00:00.000Z",
        },
        workerOutput: {
          workerJobId: "worker-1",
          workspacePath: "/worker",
          patchPath: "/evidence/output.patch",
          patchSha256,
          baseCommit: "1".repeat(40),
          changedFiles: ["src/file.ts"],
        },
      }),
      integrationDeps: () => {
        throw new Error("integration_deps_unexpected");
      },
    });

    const result = await handlers.openAttempt({
      attemptId: "attempt-reviewed",
      reviewedOutputId,
      targetWorkspacePath: "target",
      targetBranch: "feature/project",
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "confirm_open_required",
      attemptPreview: {
        sourceWorkspacePath: "/worker",
        workerOutput: {
          workerJobId: "worker-1",
          patchPath: "/evidence/output.patch",
          patchSha256,
          changedFiles: ["src/file.ts"],
        },
        reviewDecision: {
          reason: "review accepted",
          approvedFiles: ["src/file.ts"],
        },
      },
    });

    await expect(
      handlers.openAttempt({
        attemptId: "attempt-conflict",
        reviewedOutputId,
        workerPatchPath: "/caller/patch",
        targetWorkspacePath: "target",
        targetBranch: "feature/project",
      }),
    ).rejects.toThrow("reviewed_worker_output_explicit_source_conflict");
  });

  it("previews and opens a glob-allowed pinned merge while denying a non-match", async () => {
    const reviewedOutputId = "a".repeat(64);
    const patchSha256 = "b".repeat(64);
    const targetCommit = "1".repeat(40);
    const sourceCommit = "2".repeat(40);
    const sourceBranch = "fix/hosted-web-merge-source";
    const mergeController: ProjectIntegrationMcpController = {
      ...controller,
      scope: {
        ...controller.scope,
        workspaceRoots: ["/resolved/target", "/worker"],
        worktreeRoots: ["/worker"],
        jobIdPrefixes: ["merge-"],
        allowedBranches: ["feature/project", "fix/hosted-web-*", "base/*"],
        allowedGitRemotes: ["origin"],
      },
    };
    const reviewedOutput = (reviewedSourceBranch: string) =>
      ({
        snapshot: {
          format: reviewedWorkerOutputFormat,
          formatRevision: 1,
          reviewedOutputId,
          projectId: "project-1",
          controllerJobId: "controller-1",
          workerJobId: "merge-worker",
          taskId: "merge-task",
          sourceWorkspacePath: "/worker",
          patchPath: "/evidence/output.patch",
          patchSha256,
          patchByteLength: 100,
          baseCommit: targetCommit,
          changedFiles: ["src/conflict.ts"],
          reviewDecision: {
            reviewedBy: "reviewer",
            decision: ReviewDecisionStatus.Approved,
            reason: "merge conflict resolution accepted",
            approvedFiles: ["src/conflict.ts"],
            requiredChecks: [],
          },
          merge: {
            sourceRemote: "origin",
            sourceBranch: reviewedSourceBranch,
            sourceCommit,
            expectedTargetCommit: targetCommit,
          },
          capturedAt: "2026-07-13T00:00:00.000Z",
        },
        workerOutput: {
          workerJobId: "merge-worker",
          workspacePath: "/worker",
          patchPath: "/evidence/output.patch",
          patchSha256,
          baseCommit: targetCommit,
          changedFiles: ["src/conflict.ts"],
        },
      }) as const;
    const fixture = createFixture();
    const options: Parameters<
      typeof createProjectIntegrationMcpToolHandlers
    >[0] = {
      loadController: async () => mergeController,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string")
          throw new Error(`${fieldName} is required`);
        return `/resolved/${value}`;
      },
      resolveReviewedOutput: async () => reviewedOutput(sourceBranch),
      integrationDeps: () => fixture.deps(),
    };
    const handlers = createProjectIntegrationMcpToolHandlers(options);
    const merge = {
      sourceRemote: "origin",
      sourceBranch,
      sourceCommit,
      expectedTargetCommit: targetCommit,
    } as const;

    const result = await handlers.openAttempt({
      attemptId: "merge-attempt",
      reviewedOutputId,
      targetWorkspacePath: "target",
      targetBranch: "feature/project",
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "confirm_open_required",
      attemptPreview: {
        targetWorkspacePath: "/resolved/target",
        targetBranch: "feature/project",
        merge,
        workerOutput: {
          baseCommit: targetCommit,
          targetCommit,
          changedFiles: ["src/conflict.ts"],
        },
        reviewDecision: {
          approvedFiles: ["src/conflict.ts"],
        },
      },
    });

    const opened = await handlers.openAttempt({
      attemptId: "merge-attempt",
      reviewedOutputId,
      targetWorkspacePath: "target",
      targetBranch: "feature/project",
      confirmOpen: true,
    });
    expect(opened.structuredContent).toMatchObject({
      ok: true,
      attempt: {
        attemptId: "merge-attempt",
        merge,
      },
    });

    const deniedHandlers = createProjectIntegrationMcpToolHandlers({
      ...options,
      resolveReviewedOutput: async () => reviewedOutput("feature/unrelated"),
    });
    await expect(
      deniedHandlers.openAttempt({
        attemptId: "denied-merge-attempt",
        reviewedOutputId,
        targetWorkspacePath: "target",
        targetBranch: "feature/project",
      }),
    ).rejects.toThrow("project_integration_merge_source_branch_denied");

    await expect(
      handlers.openAttempt({
        attemptId: "unreviewed-merge",
        workerJobId: "merge-worker",
        workerWorkspacePath: "worker",
        workerPatchPath: "/evidence/output.patch",
        workerBaseCommit: targetCommit,
        changedFiles: ["src/conflict.ts"],
        targetWorkspacePath: "target",
        targetBranch: "feature/project",
        merge,
      }),
    ).rejects.toThrow(
      "project_integration_merge_must_be_bound_to_reviewed_output",
    );

    await expect(
      handlers.openAttempt({
        attemptId: "wrong-target-merge",
        reviewedOutputId,
        targetWorkspacePath: "target",
        targetBranch: "feature/project",
        targetCommit: "3".repeat(40),
      }),
    ).rejects.toThrow("project_integration_merge_target_commit_mismatch");
  });

  it("previews rejection reasons before invoking integration use cases", async () => {
    let integrationDepsCalls = 0;
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string")
          throw new Error(`${fieldName} is required`);
        return value;
      },
      integrationDeps: () => {
        integrationDepsCalls += 1;
        throw new Error("integration_deps_unexpected");
      },
    });

    const result = await handlers.rejectAttempt({
      attemptId: "attempt-1",
      reason: "Worker output conflicted with target policy.",
    });

    expect(integrationDepsCalls).toBe(0);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "confirm_reject_required",
      mode: "project_integration_reject_attempt",
      controllerJobId: "controller-1",
      attemptId: "attempt-1",
      rejectionReason: "Worker output conflicted with target policy.",
    });
  });
});
