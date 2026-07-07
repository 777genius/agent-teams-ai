import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ReviewDecisionStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createProjectIntegrationMcpToolHandlers,
  type ProjectIntegrationMcpController,
} from "../index";

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
        if (typeof value !== "string") throw new Error(`${fieldName} is required`);
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
      requiredChecks: [{
        checkId: "unit",
        command: ["npm", "test"],
        timeoutMs: 30_000,
      }],
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
        requiredChecks: [{
          checkId: "unit",
          command: ["npm", "test"],
          timeoutMs: 30_000,
        }],
      },
    });
  });

  it("keeps integration argument validation owned by the feature slice", async () => {
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string") throw new Error(`${fieldName} is required`);
        return value;
      },
      integrationDeps: () => {
        throw new Error("integration_deps_unexpected");
      },
    });

    await expect(handlers.openAttempt({
      attemptId: "attempt-1",
      workerJobId: "worker-1",
      workerWorkspacePath: "worker",
      targetWorkspacePath: "target",
      targetBranch: "feature/project",
      workerCommitSha: "abcdef1",
      baseStatus: "bad",
      changedFiles: ["src/file.ts"],
    })).rejects.toThrow("project_integration_base_status_invalid");
  });

  it("previews rejection reasons before invoking integration use cases", async () => {
    let integrationDepsCalls = 0;
    const handlers = createProjectIntegrationMcpToolHandlers({
      loadController: async () => controller,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string") throw new Error(`${fieldName} is required`);
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
