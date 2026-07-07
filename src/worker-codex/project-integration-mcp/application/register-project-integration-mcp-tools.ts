import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProjectIntegrationMcpToolHandlers } from "../ports/project-integration-mcp-tool-handlers";

export function registerProjectIntegrationMcpTools(
  server: McpServer,
  handlers: ProjectIntegrationMcpToolHandlers,
): void {
  server.registerTool(
    "codex_goal_project_open_integration_attempt",
    {
      title: "Project Integration Open Attempt",
      description:
        "Open a policy-controlled integration attempt for reviewed worker output.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        workerJobId: z.string().optional(),
        workerWorkspacePath: z.string().optional(),
        workerCommitSha: z.string().optional(),
        workerPatchPath: z.string().optional(),
        workerSummaryPath: z.string().optional(),
        workerBaseCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
        targetCommit: z.string().optional(),
        baseStatus: z.string().optional(),
        baseRevisionReasons: z.union([z.string(), z.array(z.string())]).optional(),
        targetBranch: z.string().optional(),
        targetRemote: z.string().optional(),
        changedFiles: z.union([z.string(), z.array(z.string())]).optional(),
        approvedFiles: z.union([z.string(), z.array(z.string())]).optional(),
        allowedPathPrefixes: z.union([z.string(), z.array(z.string())]).optional(),
        requiredCheckIds: z.union([z.string(), z.array(z.string())]).optional(),
        requiredChecks: z.array(projectIntegrationCheckSchema()).optional(),
        reviewedBy: z.string().optional(),
        reviewReason: z.string().optional(),
        allowStaleBase: z.boolean().optional(),
        confirmOpen: z.boolean().optional(),
      },
    },
    (args) => handlers.openAttempt(args),
  );

  server.registerTool(
    "codex_goal_project_apply_worker_output",
    {
      title: "Project Integration Apply Worker Output",
      description:
        "Apply reviewed worker output into the target workspace through the integration lifecycle.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        allowedPreExistingDirtyFiles: z.union([z.string(), z.array(z.string())]).optional(),
        confirmApply: z.boolean().optional(),
      },
    },
    (args) => handlers.applyWorkerOutput(args),
  );

  server.registerTool(
    "codex_goal_project_run_required_checks",
    {
      title: "Project Integration Run Required Checks",
      description:
        "Run declared integration checks for an applied integration attempt.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        confirmRunChecks: z.boolean().optional(),
      },
    },
    (args) => handlers.runRequiredChecks(args),
  );

  server.registerTool(
    "codex_goal_project_commit_approved_changes",
    {
      title: "Project Integration Commit Approved Changes",
      description:
        "Create a commit candidate after required checks and secret scan pass.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        message: z.string().optional(),
        allowedPathPrefixes: z.union([z.string(), z.array(z.string())]).optional(),
        requiredCheckIds: z.union([z.string(), z.array(z.string())]).optional(),
        confirmCommit: z.boolean().optional(),
      },
    },
    (args) => handlers.commitApprovedChanges(args),
  );

  server.registerTool(
    "codex_goal_project_push_approved_commit",
    {
      title: "Project Integration Push Approved Commit",
      description:
        "Push an approved integration commit candidate through policy-controlled branch rules.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        branch: z.string().optional(),
        remote: z.string().optional(),
        force: z.boolean().optional(),
        confirmPush: z.boolean().optional(),
      },
    },
    (args) => handlers.pushApprovedCommit(args),
  );

  server.registerTool(
    "codex_goal_project_reject_integration_attempt",
    {
      title: "Project Integration Reject Attempt",
      description:
        "Reject an integration attempt with an audited safe reason.",
      inputSchema: {
        ...projectIntegrationRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        attemptId: z.string().optional(),
        reason: z.string().optional(),
        confirmReject: z.boolean().optional(),
      },
    },
    (args) => handlers.rejectAttempt(args),
  );
}

function projectIntegrationRegistryInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    registryRootDir: z.string().optional(),
    cwd: z.string().optional(),
  };
}

function projectIntegrationCheckSchema() {
  return z.object({
    checkId: z.string(),
    command: z.array(z.string()),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  });
}
