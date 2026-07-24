import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerCodexGoalProjectControlActionTools,
} from "./codex-goal-mcp-project-control-action-tool-registration";
import {
  registerCodexGoalProjectControlAdminTools,
} from "./codex-goal-mcp-project-control-admin-tool-registration";
import {
  registerCodexGoalProjectControlJobTools,
} from "./codex-goal-mcp-project-control-job-tool-registration";
import {
  registerCodexGoalProjectControlReviewTools,
} from "./codex-goal-mcp-project-control-review-tool-registration";
import {
  registerCodexGoalProjectControllerTools,
} from "./codex-goal-mcp-project-controller-tool-registration";
import {
  registerCodexGoalProjectIntegrationTools,
} from "./codex-goal-mcp-project-integration-tool-registration";
import {
  registerCodexGoalProjectRetentionTool,
} from "./codex-goal-mcp-project-retention-tool-registration";

export function registerCodexGoalProjectControlTools(server: McpServer): void {
  registerCodexGoalProjectControlJobTools(server);
  registerCodexGoalProjectControlAdminTools(server);
  registerCodexGoalProjectControllerTools(server);
  registerCodexGoalProjectControlActionTools(server);
  registerCodexGoalProjectRetentionTool(server);
  registerCodexGoalProjectIntegrationTools(server);
  registerCodexGoalProjectControlReviewTools(server);
}
