import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jobIdInputSchema,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControlMarkReviewed,
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
}
