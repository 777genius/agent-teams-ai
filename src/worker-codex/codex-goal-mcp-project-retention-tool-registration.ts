import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  jobRegistryInputSchema,
} from "./codex-goal-mcp-inputs";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  projectControlCleanupWorktreesView,
  type ProjectRetentionMcpArgs,
} from "./codex-goal-project-retention";

export function registerCodexGoalProjectRetentionTool(
  server: McpServer,
): void {
  server.registerTool(
    "codex_goal_project_cleanup_worktrees",
    {
      title: "Project Control Cleanup Child Worktrees",
      description:
        "Preview or explicitly confirm bounded removal of exact clean terminal child worktrees owned by this ProjectScopedControl controller. Job roots and shared dependency caches are never removed.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().min(1),
        candidateIds: z.array(z.string().min(1)).min(1).max(20),
        acceptedCanonicalCommit: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .optional(),
        maxCount: z.number().int().min(1).max(20).optional(),
        confirmCleanup: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await projectControlCleanupWorktreesView(
        args as ProjectRetentionMcpArgs,
      )),
    ),
  );
}
