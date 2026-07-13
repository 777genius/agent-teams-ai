import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jobIdInputSchema,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControlMarkReviewed,
  projectControlRecordFailedNoOutput,
  projectControlStopStoredJob,
} from "./codex-goal-mcp-project-control-tool-handlers";

export function registerCodexGoalProjectControlReviewTools(server: McpServer): void {
  // Keep model-facing tool names stable and evolve additive fields in place.
  // Introduce a new public version only for an unavoidable breaking contract.
  server.registerTool(
    "codex_goal_project_stop",
    {
      title: "Project Control Stop Codex Goal Worker",
      description:
        "Stop a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        confirmStop: z.boolean().optional(),
        forceStop: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlStopStoredJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_mark_reviewed",
    {
      title: "Project Control Mark Codex Goal Reviewed",
      description:
        "Write a review marker for a stored job through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        note: z.string().optional(),
        captureReviewedOutput: z.boolean().optional(),
        expectedPatchSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
        reviewDecision: z.enum(["approved", "rejected", "needs_human"]).optional(),
        reviewedBy: z.string().optional(),
        reviewReason: z.string().optional(),
        approvedFiles: z.union([z.string(), z.array(z.string())]).optional(),
        requiredChecks: z.array(z.object({
          checkId: z.string(),
          command: z.array(z.string()),
          cwd: z.string().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })).optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlMarkReviewed(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_record_failed_no_output",
    {
      title: "Project Control Record Failed Worker Without Output",
      description:
        "Record an immutable failed_no_output terminal ledger decision for a stopped worker with complete empty authored-output evidence, or append a correction to an invalid prior decision.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().min(1),
        terminalAttemptId: z.string().min(1),
        failureCategory: z.string().min(1),
        failureCode: z.string().min(1),
        note: z.string().min(1).optional(),
        confirmFailedNoOutput: z.boolean().optional(),
        preexistingWorkspacePatchPath: z.string().min(1).optional(),
        preexistingWorkspacePatchSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
        confirmPreexistingWorkspacePatch: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRecordFailedNoOutput(args as ProjectControlMcpArgs),
    ),
  );
}
