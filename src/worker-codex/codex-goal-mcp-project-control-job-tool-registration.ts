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
  projectControlPrepareVerifier,
  projectControlRecoverOperations,
  projectControlRefillWorker,
} from "./codex-goal-mcp-project-control-tool-handlers";
import {
  projectAdmissionRefillWorkerRoleSchemaValues,
  projectAdmissionWorkerRoleSchemaValues,
} from "./codex-goal-mcp-project-control-tool-schemas";
import {
  workerLaunchAdmissionSchema,
} from "./application/project-control/worker-launch-spec";

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
        preStartAdmission: workerLaunchAdmissionSchema
          .describe(
            "Declarative worker launch admission. Runtime computes job identity, workKey, paths and state. phaseStartSha must match sourceRef/baseBranch HEAD; inputPatchHash binds the admitted input patch.",
          )
          .optional(),
        confirmPreStartAdmission: z.boolean().optional(),
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
    "codex_goal_project_prepare_verifier",
    {
      title: "Project Control Prepare Verifier",
      description:
        "Create a verifier worktree at canonical remote HEAD, atomically apply a terminal producer handoff, create the verifier job and optionally start it.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        producerJobId: z.string(),
        sourceWorkspacePath: z.string().optional(),
        baseBranch: z.string().optional(),
        newBranch: z.string().optional(),
        promptBody: z.string().optional(),
        preStartAdmission: workerLaunchAdmissionSchema
          .describe(
            "Declarative verifier launch admission. Runtime computes job identity, workKey, paths and state. phaseStartSha must match canonical source HEAD; inputPatchHash must match the terminal producer handoff.",
          )
          .optional(),
        confirmPreStartAdmission: z.boolean().optional(),
        workerRole: z.enum(["fastgate", "reviewer"]).optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        skipDoctor: z.boolean().optional(),
        startWorker: z.boolean().optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        executionMode: z.enum(["sync", "bounded", "async"]).optional(),
        confirmRefill: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlPrepareVerifier(args as ProjectControlMcpArgs),
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

  server.registerTool(
    "codex_goal_project_recover_operations",
    {
      title: "Project Control Recover Operations",
      description:
        "Idempotently reconcile or resume unfinished durable ProjectScopedControl operations under an exclusive claim.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        confirmRecoverOperations: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRecoverOperations(args as ProjectControlMcpArgs),
    ),
  );
}
