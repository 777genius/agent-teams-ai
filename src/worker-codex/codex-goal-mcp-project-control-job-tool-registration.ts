import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  goalInputSchema,
} from "./codex-goal-mcp-input-schemas";
import {
  jobRegistryInputSchema,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControlCreateCodexGoalJob,
  projectControlOperationStatus,
  projectControlRefillWorker,
} from "./codex-goal-mcp-project-control-tool-handlers";
import {
  projectAdmissionRefillWorkerRoleSchemaValues,
  projectAdmissionWorkerRoleSchemaValues,
} from "./codex-goal-mcp-project-control-tool-schemas";

export function registerCodexGoalProjectControlJobTools(server: McpServer): void {
  server.registerTool(
    "codex_goal_project_create_job",
    {
      title: "Project Control Create Codex Goal Job",
      description:
        "Create a child Codex goal job through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
        overwrite: z.boolean().optional(),
        confirmCreate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlCreateCodexGoalJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_refill_worker",
    {
      title: "Project Control Refill Worker",
      description:
        "Create a scoped worktree, write a prompt, create a child job and optionally start it through one ProjectScopedControl broker flow.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        sourceWorkspacePath: z.string().optional(),
        baseBranch: z.string().optional(),
        sourceRef: z.string().optional(),
        newBranch: z.string().optional(),
        promptBody: z.string().optional(),
        workerRole: z.enum(projectAdmissionRefillWorkerRoleSchemaValues).optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        overwrite: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        startWorker: z.boolean().optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        executionMode: z.enum(["sync", "bounded", "async"]).optional(),
        confirmRefill: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRefillWorker(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_operation_status",
    {
      title: "Project Control Operation Status",
      description:
        "Read a durable async ProjectScopedControl operation status handle created by bounded project-control tools.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        operationId: z.string(),
        includeResult: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlOperationStatus(args as ProjectControlMcpArgs),
    ),
  );
}
