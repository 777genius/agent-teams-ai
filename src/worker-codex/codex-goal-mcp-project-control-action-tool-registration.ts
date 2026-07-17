import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jobIdInputSchema,
  jobRegistryInputSchema,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControlCreateWorktree,
  projectControlIntegrateCommit,
  projectControlPushBranch,
  projectControlStartStoredJob,
} from "./codex-goal-mcp-project-control-tool-handlers";
import {
  projectAdmissionWorkerRoleSchemaValues,
} from "./codex-goal-mcp-project-control-tool-schemas";

export function registerCodexGoalProjectControlActionTools(server: McpServer): void {
  server.registerTool(
    "codex_goal_project_start",
    {
      title: "Project Control Start Codex Goal Worker",
      description:
        "Start or safely continue a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy. Pending deliverable guidance is injected before the next provider attempt.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        reviewedOutputId: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
        continuationAccounts: z
          .union([z.string(), z.array(z.string())])
          .optional(),
        confirmStart: z.boolean().optional(),
        forceStart: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlStartStoredJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_create_worktree",
    {
      title: "Project Control Create Git Worktree",
      description:
        "Create a project git worktree through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        sourceWorkspacePath: z.string().optional(),
        path: z.string().optional(),
        baseBranch: z.string().optional(),
        sourceRef: z.string().optional(),
        expectedSourceCommit: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
          .optional(),
        expectedCurrentCommit: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
          .optional(),
        newBranch: z.string().optional(),
        workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        confirmCreateWorktree: z.boolean().optional(),
        confirmFastForwardExisting: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlCreateWorktree(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_integrate_commit",
    {
      title: "Project Control Integrate Git Commit",
      description:
        "Cherry-pick a reviewed commit into a scoped project worktree through broker policy.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        workspacePath: z.string().optional(),
        branch: z.string().optional(),
        commitSha: z.string().optional(),
        confirmIntegrate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlIntegrateCommit(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_push_branch",
    {
      title: "Project Control Push Git Branch",
      description:
        "Push an allowed project branch through broker policy. External rewrite recovery requires exact local and remote commits and uses an exact force-with-lease.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        workspacePath: z.string().optional(),
        branch: z.string().optional(),
        remote: z.string().optional(),
        force: z.boolean().optional(),
        expectedRemoteCommit: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
        expectedLocalCommit: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
        confirmExternalRewriteRecovery: z.boolean().optional(),
        confirmPush: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlPushBranch(args as ProjectControlMcpArgs),
    ),
  );
}
