import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ProjectIntegrationMcpToolResponse = CallToolResult;

export type ProjectIntegrationMcpToolHandler = (
  args: unknown,
) => Promise<ProjectIntegrationMcpToolResponse>;

export type ProjectIntegrationMcpToolHandlers = {
  readonly openAttempt: ProjectIntegrationMcpToolHandler;
  readonly applyWorkerOutput: ProjectIntegrationMcpToolHandler;
  readonly runRequiredChecks: ProjectIntegrationMcpToolHandler;
  readonly commitApprovedChanges: ProjectIntegrationMcpToolHandler;
  readonly pushApprovedCommit: ProjectIntegrationMcpToolHandler;
  readonly rejectAttempt: ProjectIntegrationMcpToolHandler;
};
