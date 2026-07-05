import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodexGoalMcpServer } from "./codex-goal-mcp";

type JsonRecord = Record<string, unknown>;
type SuperviseEvent =
  | { readonly type: "start"; readonly result: unknown }
  | { readonly type: "status"; readonly result: unknown }
  | { readonly type: "reconcile"; readonly result: unknown }
  | { readonly type: "stop"; readonly result: unknown };

export enum ControllerSupervisorObservedStatus {
  Planned = "planned",
  Running = "running",
  Completed = "completed",
  Stopped = "stopped",
  Blocked = "blocked",
  Failed = "failed",
  Stale = "stale",
}

const requiredCodexGoalMcpTools = [
  "codex_goal_list_jobs",
  "codex_goal_overview",
  "agent_run_watch",
  "codex_goal_run_watch",
  "codex_goal_get_job",
  "codex_goal_create_job",
  "codex_goal_status_by_id",
  "codex_goal_reconcile_preview",
  "codex_goal_brief",
  "codex_goal_decision",
  "codex_goal_handoff",
  "codex_goal_accounts_status",
  "codex_goal_continue",
  "codex_goal_recover",
  "codex_goal_stop",
  "codex_goal_assert_single_writer",
  "codex_goal_mark_reviewed",
] as const;

export async function listCodexGoalMcpTools(): Promise<unknown> {
  return withCodexGoalMcpClient((client) => client.listTools());
}

export async function callCodexGoalMcpTool(input: {
  readonly name: string;
  readonly args?: JsonRecord;
}): Promise<unknown> {
  return withCodexGoalMcpClient(async (client) =>
    parseMcpJsonResult(await client.callTool({
      name: input.name,
      arguments: input.args ?? {},
    }))
  );
}

export async function superviseCodexGoalProjectController(input: {
  readonly args: JsonRecord;
  readonly statusIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: SuperviseEvent) => void;
}): Promise<{
  readonly ok: boolean;
  readonly start: unknown;
  readonly finalStatus?: unknown;
  readonly stop?: unknown;
}> {
  const server = createCodexGoalMcpServer();
  const client = new Client({
    name: "subscription-runtime-codex-goal-controller-supervisor",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const start = parseMcpJsonResult(await client.callTool({
      name: "codex_goal_project_controller_start",
      arguments: input.args,
    }));
    input.onEvent?.({ type: "start", result: start });
    if (!mcpResultOk(start)) return { ok: false, start };

    let lastStatus: unknown = start;
    while (!input.signal?.aborted) {
      try {
        await sleep(input.statusIntervalMs ?? 60_000, undefined, {
          signal: input.signal,
        });
      } catch (error) {
        if (isAbortError(error)) break;
        throw error;
      }
      const status = parseMcpJsonResult(await client.callTool({
        name: "codex_goal_project_controller_status",
        arguments: input.args,
      }));
      lastStatus = status;
      input.onEvent?.({ type: "status", result: status });
      if (!mcpResultOk(status)) {
        return { ok: false, start, finalStatus: status };
      }
      const runStatus = controllerSupervisorObservedStatus(status);
      if (runStatus !== undefined && controllerSupervisorStatusIsTerminal(runStatus)) {
        const reconcile = parseMcpJsonResult(await client.callTool({
          name: "codex_goal_project_controller_reconcile",
          arguments: input.args,
        }));
        input.onEvent?.({ type: "reconcile", result: reconcile });
        return {
          ok: mcpResultOk(reconcile) && controllerSupervisorTerminalStatusSucceeded(runStatus),
          start,
          finalStatus: reconcile,
        };
      }
    }

    const stop = parseMcpJsonResult(await client.callTool({
      name: "codex_goal_project_controller_stop",
      arguments: {
        ...input.args,
        reason: "controller_supervisor_stopped",
      },
    }));
    input.onEvent?.({ type: "stop", result: stop });
    return {
      ok: mcpResultOk(stop),
      start,
      finalStatus: lastStatus,
      stop,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

export function controllerSupervisorObservedStatus(
  result: unknown,
): ControllerSupervisorObservedStatus | undefined {
  return controllerSupervisorStatusValue([
    nestedRecord(result, "providerObserved")?.status,
    nestedRecord(result, "liveController")?.providerObservedStatus,
    nestedRecord(result, "run")?.status,
    nestedRecord(result, "session")?.status,
    isRecord(result) ? result.status : undefined,
  ]);
}

export function controllerSupervisorStatusIsTerminal(
  status: ControllerSupervisorObservedStatus,
): boolean {
  return status !== ControllerSupervisorObservedStatus.Planned &&
    status !== ControllerSupervisorObservedStatus.Running;
}

function controllerSupervisorTerminalStatusSucceeded(
  status: ControllerSupervisorObservedStatus,
): boolean {
  return status === ControllerSupervisorObservedStatus.Completed ||
    status === ControllerSupervisorObservedStatus.Stopped;
}

function controllerSupervisorStatusValue(
  candidates: readonly unknown[],
): ControllerSupervisorObservedStatus | undefined {
  for (const candidate of candidates) {
    if (
      candidate === ControllerSupervisorObservedStatus.Planned ||
      candidate === ControllerSupervisorObservedStatus.Running ||
      candidate === ControllerSupervisorObservedStatus.Completed ||
      candidate === ControllerSupervisorObservedStatus.Stopped ||
      candidate === ControllerSupervisorObservedStatus.Blocked ||
      candidate === ControllerSupervisorObservedStatus.Failed ||
      candidate === ControllerSupervisorObservedStatus.Stale
    ) {
      return candidate;
    }
  }
  return undefined;
}

export async function listCodexGoalMcpResources(): Promise<unknown> {
  return withCodexGoalMcpClient((client) => client.listResources());
}

export async function readCodexGoalMcpResource(input: {
  readonly uri: string;
}): Promise<unknown> {
  return withCodexGoalMcpClient((client) => client.readResource({ uri: input.uri }));
}

export async function listCodexGoalMcpPrompts(): Promise<unknown> {
  return withCodexGoalMcpClient((client) => client.listPrompts());
}

export async function getCodexGoalMcpPrompt(input: {
  readonly name: string;
  readonly args?: JsonRecord;
}): Promise<unknown> {
  return withCodexGoalMcpClient((client) =>
    client.getPrompt({
      name: input.name,
      arguments: Object.fromEntries(
        Object.entries(input.args ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    })
  );
}

export async function doctorCodexGoalControlSurface(): Promise<{
  readonly ok: boolean;
  readonly mode: "sdk-in-process";
  readonly toolCount: number;
  readonly requiredTools: readonly string[];
  readonly missingTools: readonly string[];
  readonly fallbackExamples: readonly string[];
  readonly installNativeMcpCommand: string;
}> {
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
      "subscription-runtime-codex-goal run-watch --provider codex --include-log-tail --tail-lines 20 --json",
      "subscription-runtime-codex-goal reconcile-preview --registry-root <dir>",
      "subscription-runtime-codex-goal tool codex_goal_status_by_id --args-json '{\"jobId\":\"<jobId>\"}'",
      "subscription-runtime-codex-goal brief <jobId>",
      "subscription-runtime-codex-goal decision <jobId>",
      "subscription-runtime-codex-goal handoff <jobId>",
      "subscription-runtime-codex-goal accounts <jobId>",
      "subscription-runtime-codex-goal continue-job <jobId> --confirm",
      "subscription-runtime-codex-goal stop-job <jobId> --confirm",
    ],
    installNativeMcpCommand:
      `codex mcp add subscription-runtime-codex-goal -- "$(command -v node)" ${shellQuote(nativeMcpScriptPath())}`,
  };
}

async function withCodexGoalMcpClient<T>(
  action: (client: Client) => Promise<T>,
): Promise<T> {
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
  } finally {
    await client.close();
    await server.close();
  }
}

function parseMcpJsonResult(result: unknown): unknown {
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
    } catch {
      return { text: first.text };
    }
  }
  return result;
}

function mcpResultOk(value: unknown): boolean {
  return isRecord(value) && value.ok !== false;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function toolNamesFromResult(result: unknown): ReadonlySet<string> {
  const tools = isRecord(result) && Array.isArray(result.tools)
    ? result.tools
    : [];
  return new Set(
    tools
      .map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined)
      .filter((name): name is string => Boolean(name)),
  );
}

function nativeMcpScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "codex-goal-mcp.js");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
