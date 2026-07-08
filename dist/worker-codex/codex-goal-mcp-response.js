export function mcpJson(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}
export async function withMcpErrors(action) {
    try {
        return await action();
    }
    catch (error) {
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
//# sourceMappingURL=codex-goal-mcp-response.js.map