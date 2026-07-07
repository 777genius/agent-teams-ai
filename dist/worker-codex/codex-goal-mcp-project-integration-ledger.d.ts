/// <reference types="node" />
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectIntegrationMcpLoadController, ProjectIntegrationMcpToolHandler } from "./project-integration-mcp/index.js";
export declare function projectIntegrationPushApprovedCommitWithConsumedLedger(input: {
    readonly args: unknown;
    readonly loadController: ProjectIntegrationMcpLoadController;
    readonly pushApprovedCommitHandler: ProjectIntegrationMcpToolHandler;
}): Promise<CallToolResult>;
//# sourceMappingURL=codex-goal-mcp-project-integration-ledger.d.ts.map