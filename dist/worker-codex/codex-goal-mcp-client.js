import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodexGoalMcpServer } from "./codex-goal-mcp.js";
const requiredCodexGoalMcpTools = [
    "codex_goal_list_jobs",
    "codex_goal_overview",
    "agent_run_watch",
    "codex_goal_run_watch",
    "codex_goal_get_job",
    "codex_goal_create_job",
    "codex_goal_status_by_id",
    "codex_goal_reconcile_preview",
    "codex_goal_watch",
    "codex_goal_brief",
    "codex_goal_decision",
    "codex_goal_handoff",
    "codex_goal_accounts_status",
    "codex_goal_continue",
    "codex_goal_recover",
    "codex_goal_stop",
    "codex_goal_assert_single_writer",
    "codex_goal_mark_reviewed",
];
export async function listCodexGoalMcpTools() {
    return withCodexGoalMcpClient((client) => client.listTools());
}
export async function callCodexGoalMcpTool(input) {
    return withCodexGoalMcpClient(async (client) => parseMcpJsonResult(await client.callTool({
        name: input.name,
        arguments: input.args ?? {},
    })));
}
export async function listCodexGoalMcpResources() {
    return withCodexGoalMcpClient((client) => client.listResources());
}
export async function readCodexGoalMcpResource(input) {
    return withCodexGoalMcpClient((client) => client.readResource({ uri: input.uri }));
}
export async function listCodexGoalMcpPrompts() {
    return withCodexGoalMcpClient((client) => client.listPrompts());
}
export async function getCodexGoalMcpPrompt(input) {
    return withCodexGoalMcpClient((client) => client.getPrompt({
        name: input.name,
        arguments: Object.fromEntries(Object.entries(input.args ?? {}).map(([key, value]) => [key, String(value)])),
    }));
}
export async function doctorCodexGoalControlSurface() {
    const toolsResult = await listCodexGoalMcpTools();
    const toolNames = toolNamesFromResult(toolsResult);
    const missingTools = requiredCodexGoalMcpTools.filter((tool) => !toolNames.has(tool));
    return {
        ok: missingTools.length === 0,
        mode: "sdk-in-process",
        toolCount: toolNames.size,
        requiredTools: requiredCodexGoalMcpTools,
        missingTools,
        fallbackExamples: [
            "subscription-runtime-codex-goal tools",
            "subscription-runtime-codex-goal overview",
            "subscription-runtime-codex-goal run-watch --include-log-tail --tail-lines 20",
            "subscription-runtime-codex-goal reconcile-preview --registry-root <dir>",
            "subscription-runtime-codex-goal tool codex_goal_status_by_id --args-json '{\"jobId\":\"<jobId>\"}'",
            "subscription-runtime-codex-goal brief <jobId>",
            "subscription-runtime-codex-goal decision <jobId>",
            "subscription-runtime-codex-goal handoff <jobId>",
            "subscription-runtime-codex-goal accounts <jobId>",
            "subscription-runtime-codex-goal continue-job <jobId> --confirm",
            "subscription-runtime-codex-goal stop-job <jobId> --confirm",
        ],
        installNativeMcpCommand: `codex mcp add subscription-runtime-codex-goal -- "$(command -v node)" ${shellQuote(nativeMcpScriptPath())}`,
    };
}
async function withCodexGoalMcpClient(action) {
    const server = createCodexGoalMcpServer();
    const client = new Client({
        name: "subscription-runtime-codex-goal-cli",
        version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        return await action(client);
    }
    finally {
        await client.close();
        await server.close();
    }
}
function parseMcpJsonResult(result) {
    if (isRecord(result) && "structuredContent" in result) {
        return result.structuredContent;
    }
    const content = isRecord(result) && Array.isArray(result.content)
        ? result.content
        : undefined;
    const first = content?.[0];
    if (isRecord(first) && first.type === "text" && typeof first.text === "string") {
        try {
            return JSON.parse(first.text);
        }
        catch {
            return { text: first.text };
        }
    }
    return result;
}
function toolNamesFromResult(result) {
    const tools = isRecord(result) && Array.isArray(result.tools)
        ? result.tools
        : [];
    return new Set(tools
        .map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined)
        .filter((name) => Boolean(name)));
}
function nativeMcpScriptPath() {
    return join(dirname(fileURLToPath(import.meta.url)), "codex-goal-mcp.js");
}
function shellQuote(value) {
    if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-mcp-client.js.map