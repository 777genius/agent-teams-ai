import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodexGoalMcpServer } from "./codex-goal-mcp";

type JsonRecord = Record<string, unknown>;
type SuperviseEvent =
  | { readonly type: "operation_recovery"; readonly result: unknown }
  | { readonly type: "start"; readonly result: unknown }
  | { readonly type: "status"; readonly result: unknown }
  | { readonly type: "reconcile"; readonly result: unknown }
  | { readonly type: "control_decision"; readonly result: unknown }
  | { readonly type: "accounts"; readonly result: unknown }
  | { readonly type: "capacity_wait"; readonly result: unknown }
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
  "codex_goal_reconcile_preview",
  "agent_run_watch",
  "codex_goal_run_watch",
  "agent_run_events",
  "codex_goal_events",
  "agent_run_state",
  "codex_goal_state",
  "agent_run_event_compaction_plan",
  "agent_run_event_compact",
  "agent_run_project_events",
  "codex_goal_project_events",
  "codex_goal_get_job",
  "codex_goal_create_job",
  "codex_goal_update_job",
  "codex_goal_status_by_id",
  "codex_goal_recommend_next_action",
  "codex_goal_assert_single_writer",
  "codex_goal_reconcile_result",
  "codex_goal_continue",
  "codex_goal_recover",
  "codex_goal_stop",
  "codex_goal_maintenance_pause",
  "codex_goal_pause",
  "codex_goal_send_guidance",
  "codex_goal_control_enqueue",
  "codex_goal_control_list",
  "codex_goal_control_decision",
  "codex_goal_control_reconcile",
  "codex_goal_control_supersede",
  "codex_goal_mark_reviewed",
  "codex_goal_brief",
  "codex_goal_decision",
  "codex_goal_handoff",
  "codex_goal_accounts_status",
  "codex_goal_accounts_list_pools",
  "codex_goal_accounts_relogin_instructions",
  "codex_goal_dry_run",
  "codex_goal_start",
  "codex_goal_project_create_job",
  "codex_goal_project_refill_worker",
  "codex_goal_project_prepare_verifier",
  "codex_goal_project_recover_operations",
  "codex_goal_project_admission_snapshot",
  "codex_goal_project_update_controller_scope",
  "brokered_project_manifest_repair",
  "codex_goal_project_controller_launch_plan",
  "codex_goal_project_controller_start",
  "codex_goal_project_controller_status",
  "codex_goal_project_controller_consume_guidance",
  "codex_goal_project_controller_stop",
  "codex_goal_project_controller_reconcile",
  "codex_goal_project_start",
  "codex_goal_project_create_worktree",
  "codex_goal_project_integrate_commit",
  "codex_goal_project_push_branch",
  "codex_goal_project_open_integration_attempt",
  "codex_goal_project_apply_worker_output",
  "codex_goal_project_run_required_checks",
  "codex_goal_project_commit_approved_changes",
  "codex_goal_project_push_approved_commit",
  "codex_goal_project_reject_integration_attempt",
  "codex_goal_project_stop",
  "codex_goal_project_mark_reviewed",
  "codex_goal_status",
  "codex_goal_doctor",
  "codex_goal_tail",
  "codex_accounts_list_pools",
  "codex_accounts_status",
  "codex_accounts_relogin_instructions",
] as const;

export async function listCodexGoalMcpTools(): Promise<unknown> {
  return withCodexGoalMcpClient((client) => client.listTools());
}

export async function callCodexGoalMcpTool(input: {
  readonly name: string;
  readonly args?: JsonRecord;
}): Promise<unknown> {
  const timeout = codexGoalMcpToolTimeoutMs(input.name);
  return withCodexGoalMcpClient(async (client) =>
    parseMcpJsonResult(await client.callTool({
      name: input.name,
      arguments: input.args ?? {},
    }, undefined, timeout === undefined ? undefined : { timeout }))
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
    let start: unknown = null;
    let lastStatus: unknown = start;
    let lastGuidanceRestartSignature: string | undefined;
    while (!input.signal?.aborted) {
      const operationRecovery = parseMcpJsonResult(await client.callTool({
        name: "codex_goal_project_recover_operations",
        arguments: {
          ...input.args,
          confirmRecoverOperations: true,
        },
      }));
      input.onEvent?.({
        type: "operation_recovery",
        result: operationRecovery,
      });
      if (!mcpResultOk(operationRecovery)) {
        return { ok: false, start: operationRecovery };
      }
      start = parseMcpJsonResult(await client.callTool({
        name: "codex_goal_project_controller_start",
        arguments: input.args,
      }));
      input.onEvent?.({ type: "start", result: start });
      if (!mcpResultOk(start)) return { ok: false, start };
      lastStatus = start;

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
        if (runStatus === ControllerSupervisorObservedStatus.Running) {
          const controlDecision = parseMcpJsonResult(await client.callTool({
            name: "codex_goal_control_decision",
            arguments: controllerSupervisorJobArgs(input.args),
          }));
          const guidanceSignature = controllerSupervisorDeliverableGuidanceSignature(
            controlDecision,
          );
          if (
            mcpResultOk(controlDecision) &&
            guidanceSignature !== undefined &&
            guidanceSignature !== lastGuidanceRestartSignature
          ) {
            input.onEvent?.({ type: "control_decision", result: controlDecision });
            lastGuidanceRestartSignature = guidanceSignature;
            const stop = parseMcpJsonResult(await client.callTool({
              name: "codex_goal_project_controller_stop",
              arguments: {
                ...input.args,
                reason: "controller_supervisor_guidance_restart",
              },
            }));
            input.onEvent?.({ type: "stop", result: stop });
            if (!mcpResultOk(stop)) return { ok: false, start, finalStatus: status, stop };
            break;
          }
        }
        if (runStatus !== undefined && controllerSupervisorStatusIsTerminal(runStatus)) {
          const reconcile = parseMcpJsonResult(await client.callTool({
            name: "codex_goal_project_controller_reconcile",
            arguments: input.args,
          }));
          input.onEvent?.({ type: "reconcile", result: reconcile });
          const controlDecision = controllerSupervisorStatusRequiresControlDecision(runStatus)
            ? parseMcpJsonResult(await client.callTool({
              name: "codex_goal_control_decision",
              arguments: controllerSupervisorJobArgs(input.args),
            }))
            : undefined;
          if (controlDecision !== undefined) {
            input.onEvent?.({ type: "control_decision", result: controlDecision });
          }
          if (
            mcpResultOk(reconcile) &&
            controllerSupervisorTerminalStatusCanRetry(
              runStatus,
              reconcile,
              controlDecision,
            )
          ) {
            const accountsStatus = parseMcpJsonResult(await client.callTool({
              name: "codex_goal_accounts_status",
              arguments: controllerSupervisorJobArgs(input.args),
            }));
            input.onEvent?.({ type: "accounts", result: accountsStatus });
            if (controllerSupervisorHasAvailableAccounts(accountsStatus)) {
              break;
            }
            const retryAfterMs = controllerSupervisorNextCapacityRetryDelayMs(accountsStatus);
            if (retryAfterMs !== undefined) {
              input.onEvent?.({
                type: "capacity_wait",
                result: {
                  ok: true,
                  mode: "project_controller_capacity_wait",
                  controllerJobId: controllerSupervisorControllerJobId(input.args),
                  retryAfterMs,
                },
              });
              try {
                await sleep(retryAfterMs, undefined, { signal: input.signal });
              } catch (error) {
                if (isAbortError(error)) break;
                throw error;
              }
              break;
            }
          }
          return {
            ok: mcpResultOk(reconcile) && controllerSupervisorTerminalStatusSucceeded(runStatus),
            start,
            finalStatus: reconcile,
          };
        }
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

export function controllerSupervisorStatusRequiresControlDecision(
  status: ControllerSupervisorObservedStatus,
): boolean {
  return status === ControllerSupervisorObservedStatus.Blocked;
}

export function controllerSupervisorTerminalStatusCanRetry(
  status: ControllerSupervisorObservedStatus,
  reconcile: unknown,
  controlDecision?: unknown,
): boolean {
  if (status === ControllerSupervisorObservedStatus.Blocked) {
    return controllerSupervisorHasDeliverableGuidance(controlDecision);
  }
  return status === ControllerSupervisorObservedStatus.Failed &&
    (
      controllerSupervisorQuotaFailure(reconcile) ||
      controllerSupervisorTimeoutFailure(reconcile) ||
      controllerSupervisorTransientRuntimeFailure(reconcile)
    );
}

export function controllerSupervisorHasAvailableAccounts(result: unknown): boolean {
  if (isRecord(result) && result.ok === false) return false;
  const summary = nestedRecord(result, "summary");
  const available = summary?.availableDeduped ??
    (isRecord(result) ? result.available : undefined);
  return typeof available === "number" && available > 0;
}

export function controllerSupervisorHasDeliverableGuidance(result: unknown): boolean {
  if (isRecord(result) && result.ok === false) return false;
  const decision = nestedRecord(result, "decision");
  const candidates = [
    decision?.deliverableCount,
    decision?.deliverableGuidanceCount,
    decision?.pendingDeliverableCount,
    isRecord(result) ? result.deliverableCount : undefined,
    isRecord(result) ? result.deliverableGuidanceCount : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && candidate > 0) return true;
  }
  const signals = Array.isArray(decision?.deliverableSignals)
    ? decision?.deliverableSignals
    : Array.isArray(decision?.signals)
    ? decision?.signals
    : undefined;
  return Array.isArray(signals) && signals.length > 0;
}

export function controllerSupervisorDeliverableGuidanceSignature(
  result: unknown,
): string | undefined {
  if (!controllerSupervisorHasDeliverableGuidance(result)) return undefined;
  const decision = nestedRecord(result, "decision");
  const signals = Array.isArray(decision?.deliverableSignals)
    ? decision?.deliverableSignals
    : Array.isArray(decision?.signals)
    ? decision?.signals
    : undefined;
  if (Array.isArray(signals) && signals.length > 0) {
    const ids = signals
      .map((item) => {
        if (!isRecord(item)) return undefined;
        if (typeof item.signalId === "string") return item.signalId;
        if (typeof item.id === "string") return item.id;
        const signal = item.signal;
        return isRecord(signal) && typeof signal.signalId === "string"
          ? signal.signalId
          : undefined;
      })
      .filter((value): value is string => value !== undefined);
    if (ids.length > 0) return ids.join(",");
  }
  const count = decision?.deliverableCount ??
    decision?.deliverableGuidanceCount ??
    decision?.pendingDeliverableCount ??
    (isRecord(result) ? result.deliverableCount : undefined) ??
    (isRecord(result) ? result.deliverableGuidanceCount : undefined);
  return typeof count === "number" && count > 0 ? `count:${count}` : undefined;
}

export function controllerSupervisorNextCapacityRetryDelayMs(
  result: unknown,
  nowMs = Date.now(),
): number | undefined {
  if (isRecord(result) && result.ok === false) return undefined;
  const retryAt = controllerSupervisorCooldownInstants(result)
    .filter((instant) => instant > nowMs)
    .sort((left, right) => left - right)[0];
  if (retryAt === undefined) return undefined;
  return Math.max(1_000, retryAt - nowMs);
}

function controllerSupervisorTerminalStatusSucceeded(
  status: ControllerSupervisorObservedStatus,
): boolean {
  return status === ControllerSupervisorObservedStatus.Completed ||
    status === ControllerSupervisorObservedStatus.Stopped;
}

export function controllerSupervisorJobArgs(args: JsonRecord): JsonRecord {
  const controllerJobId = controllerSupervisorControllerJobId(args);
  return controllerJobId === undefined ? args : {
    ...args,
    jobId: controllerJobId,
  };
}

function controllerSupervisorControllerJobId(args: JsonRecord): string | undefined {
  return typeof args.controllerJobId === "string"
    ? args.controllerJobId
    : typeof args.jobId === "string"
    ? args.jobId
    : undefined;
}

function controllerSupervisorCooldownInstants(result: unknown): readonly number[] {
  const records = [
    ...recordArray(result, "accounts"),
    ...recordArray(result, "slots"),
  ];
  const instants: number[] = [];
  for (const record of records) {
    const cooldownUntil = record.capacityCooldownUntil;
    if (typeof cooldownUntil !== "string") continue;
    const instant = Date.parse(cooldownUntil);
    if (Number.isFinite(instant)) instants.push(instant);
  }
  return instants;
}

export function codexGoalMcpToolTimeoutMs(name: string): number | undefined {
  if (name.startsWith("codex_goal_project_")) {
    return 300_000;
  }
  return undefined;
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

function controllerSupervisorQuotaFailure(result: unknown): boolean {
  return /\b(?:quota|billing limit|usage limit|rate limit)\b/i.test(
    controllerSupervisorSafeMessage(result),
  );
}

function controllerSupervisorTimeoutFailure(result: unknown): boolean {
  return /\b(?:timed out|timeout)\b/i.test(
    controllerSupervisorSafeMessage(result),
  );
}

function controllerSupervisorTransientRuntimeFailure(result: unknown): boolean {
  return /\b(?:codex runtime failed|codex provider output was invalid|codex app-server goal backend is temporarily blocked|codex app-server goal slice exhausted)\b/i.test(
    controllerSupervisorSafeMessage(result),
  );
}

function controllerSupervisorSafeMessage(result: unknown): string {
  return String(
    nestedRecord(result, "run")?.safeMessage ??
      nestedRecord(result, "session")?.safeMessage ??
      (isRecord(result) ? result.safeMessage : undefined) ??
      "",
  );
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
      "subscription-runtime-codex-goal control-decision <jobId>",
      "subscription-runtime-codex-goal continue-job <jobId> --confirm",
      "subscription-runtime-codex-goal recover-job <jobId> --confirm",
      "subscription-runtime-codex-goal stop-job <jobId> --confirm",
      "subscription-runtime-codex-goal controller-supervise --controller-job-id <jobId>",
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
  if (!isRecord(nested)) return undefined;
  const safeMessage = nested.safeMessage;
  if (
    typeof safeMessage === "string" &&
    /\b(?:session is invalid|provider session invalid|needs reconnect)\b/i.test(safeMessage)
  ) {
    // Controller supervision treats provider session invalidation as a retriable transient failure.
    return { ...nested, safeMessage: `${safeMessage} Codex runtime failed.` };
  }
  return nested;
}

function recordArray(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter((item): item is Record<string, unknown> => isRecord(item));
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
