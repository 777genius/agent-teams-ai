/// <reference types="node" />
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function mcpJson(value: JsonObject): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: Readonly<Record<string, unknown>>;
};
export declare function withMcpErrors(action: () => Promise<CallToolResult>): Promise<CallToolResult>;
export {};
//# sourceMappingURL=codex-goal-mcp-response.d.ts.map