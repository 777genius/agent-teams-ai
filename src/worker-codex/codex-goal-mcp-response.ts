import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type JsonObject = Readonly<Record<string, unknown>>;

export function mcpJson(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export async function withMcpErrors(
  action: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    const value = {
      ok: false,
      error: error instanceof Error ? error.message : "codex_goal_mcp_error",
    };
    return {
      ...mcpJson(value),
      isError: true,
    };
  }
}
