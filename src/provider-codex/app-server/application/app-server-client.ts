import { EventEmitter, once as onceEvent } from "node:events";
import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { pruneCodexChildEnv } from "../../codex-cli-domain";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type {
  CodexMaterializedSession,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "./app-server-process-port";
import {
  appServerGoalObjectiveLimitError,
  formatGoalSetError,
} from "../domain/app-server-goal-policy";
import {
  codexAppServerSandboxPolicy,
  codexAppServerThreadRuntimePolicy,
  type AppServerWarning,
  type CodexAppServerCommandApprovalDecision,
  type CodexAppServerCommandApprovalInput,
  type CodexAppServerCommandApprovalPolicy,
  type CodexAppServerNativeToolSurface,
  type CodexAppServerSandboxPolicy,
  type CodexThreadGoal,
  type CodexThreadGoalStatus,
} from "../domain/app-server-types";
import { mergeAgentUsage, readUsageFromRecords } from "../domain/app-server-usage";
import { safeMessage, throwIfAborted } from "../domain/app-server-errors";
import { isCodexAppServerReconnectProgressMessage } from "../protocol/app-server-event-parser";
import { readGoal } from "../protocol/app-server-goal-protocol";
import { readCodexModelCatalogPage } from "../protocol/app-server-model-catalog";
import {
  encodeJsonRpcMessage,
  parseJsonRpcLine,
  type CodexAppServerJsonRpcResponse,
} from "../protocol/app-server-json-rpc";
import {
  CodexModelUnavailableError,
  hasCodexModel,
  isCodexModelUnavailableMessage,
  type CodexModelCatalogEntry,
} from "../domain/model-catalog";
import {
  agentMessageText,
  nestedString,
  readRecord,
  stringArrayField,
  stringField,
} from "../protocol/app-server-content-parser";

export type AppServerTurnResult = {
  readonly outputText: string;
  readonly usage: AgentUsage | undefined;
  readonly completed: boolean;
  readonly error: Error | null;
};

type TurnState = {
  outputText: string;
  usage: AgentUsage | undefined;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: CodexAppServerJsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

export class CodexAppServerClient {
  private nextId = 1;
  private child: CodexAppServerChildProcess | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingTurnIdsByThread = new Map<string, string>();
  private readonly earlyTurnIdsByThread = new Map<string, string>();
  private readonly turnIdAliases = new Map<string, string>();
  private readonly serverRequests: AppServerWarning[] = [];
  private readonly backgroundWarnings: AppServerWarning[] = [];
  private exited = false;
  private terminalError: Error | null = null;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly session: CodexMaterializedSession;
      readonly workspacePath: string;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly timeoutMs: number;
      readonly startupTimeoutMs: number;
      readonly reconnectGraceMs: number;
      readonly abortSignal: AbortSignal;
    },
  ) {}

  async start(): Promise<void> {
    throwIfAborted(this.options.abortSignal);
    this.exited = false;
    this.terminalError = null;
    const env = {
      ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
      ...this.options.session.env,
      CI: "true",
    };
    this.child = this.options.processFactory({
      command: this.options.codexBinaryPath,
      args: ["app-server", "--listen", "stdio://"],
      cwd: this.options.session.home,
      env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    this.child.stderr.on("data", () => {
      // Keep stderr private. Codex may include environment or auth diagnostics.
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.recordTerminalError(
        new Error(`codex_app_server_exited:${code ?? signal}`),
      );
    });
    this.child.on("error", (error) => {
      this.recordTerminalError(error);
    });
    this.child.stdin.on?.("error", (error) => {
      this.recordTerminalError(error);
    });

    const response = await this.send(
      "initialize",
      {
        clientInfo: {
          name: "subscription-runtime",
          title: "ReviewRouter subscription runtime",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      {
        timeoutMs: this.options.startupTimeoutMs,
        abortSignal: this.options.abortSignal,
      },
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_initialize_failed:${response.error.message ?? "unknown"}`,
      );
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (this.exited) return;
    const exit = onceEvent(child as unknown as EventEmitter, "exit").catch(
      () => undefined,
    );
    try {
      child.stdin.end();
    } catch {
      // The process may have already closed stdin.
    }
    this.options.signalChildProcess(child, "SIGTERM");
    const timeout = setTimeout(() => {
      this.options.signalChildProcess(child, "SIGKILL");
    }, 5_000);
    try {
      await exit;
    } catch {
      // Best-effort shutdown.
    } finally {
      clearTimeout(timeout);
      this.options.signalChildProcess(child, "SIGKILL");
    }
  }

  drainWarnings(): AppServerWarning[] {
    const warnings = [...this.backgroundWarnings, ...this.serverRequests];
    this.backgroundWarnings.length = 0;
    this.serverRequests.length = 0;
    return warnings;
  }

  pushBackgroundWarning(warning: AppServerWarning): void {
    this.backgroundWarnings.push(warning);
  }

  async startThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
  }): Promise<string> {
    const disableTools = this.disableAllTools(input.goalMode);
    const disableNativeEnvironments = this.disableNativeEnvironments(
      input.goalMode,
    );
    const threadPolicy = codexAppServerThreadRuntimePolicy({
      workspacePath: input.workspacePath,
      ...(input.sandboxMode === undefined
        ? {}
        : { sandboxMode: input.sandboxMode }),
      sourceEnv: this.options.sourceEnv,
      baseDeveloperInstructions:
        this.options.executionProfile.developerInstructions,
      ...(input.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.systemPrompt }),
    });
    const features = {
      apps: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      shell_snapshot: false,
      skill_mcp_dependency_install: false,
      ...(input.serviceTier === "fast" ? { fast_mode: true } : {}),
      ...(input.goalMode ? { goals: true } : {}),
    };
    const response = await this.send(
      "thread/start",
      {
        runtimeWorkspaceRoots: threadPolicy.runtimeWorkspaceRoots,
        model: input.model,
        modelProvider: null,
        serviceTier: input.serviceTier ?? null,
        cwd: input.workspacePath,
        approvalPolicy: this.approvalPolicyForThread(),
        approvalsReviewer: null,
        sandbox: threadPolicy.sandboxMode,
        config: {
          model_reasoning_effort: input.reasoningEffort,
          model_verbosity: "low",
          ...(input.serviceTier === undefined
            ? {}
            : { service_tier: input.serviceTier }),
          approval_policy:
            this.options.commandApprovalPolicy === undefined ? "never" : "on-request",
          sandbox_mode: threadPolicy.sandboxMode,
          web_search: "disabled",
          features,
          apps: {
            _default: {
              enabled: false,
              destructive_enabled: false,
              open_world_enabled: false,
            },
          },
        },
        serviceName: "subscription-runtime",
        baseInstructions: this.options.executionProfile.baseInstructions,
        developerInstructions: threadPolicy.developerInstructions,
        personality: null,
        ephemeral: input.goalMode ? false : true,
        sessionStartSource: "startup",
        threadSource: "user",
        ...(disableTools
          ? {
              environments: [],
              dynamicTools: [],
              experimentalRawEvents: false,
            }
          : disableNativeEnvironments
          ? {
              environments: [],
            }
          : {}),
      },
      input,
    );
    if (response.error) {
      const modelError = await this.modelUnavailableError({
        requestedModel: input.model,
        ...(response.error.message === undefined
          ? {}
          : { providerMessage: response.error.message }),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });
      if (modelError) throw modelError;
      throw new Error(
        `codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`,
      );
    }

    const threadId = nestedString(response.result, ["thread", "id"]);
    if (!threadId) throw new Error("codex_app_server_thread_id_missing");
    return threadId;
  }

  private async modelUnavailableError(input: {
    readonly requestedModel: string;
    readonly providerMessage?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexModelUnavailableError | null> {
    if (!isCodexModelUnavailableMessage(input.providerMessage ?? "")) {
      return null;
    }
    const availableModels = await this.readAvailableModels(input).catch(
      () => null,
    );
    if (availableModels === null || hasCodexModel(availableModels, input.requestedModel)) {
      return null;
    }
    return new CodexModelUnavailableError({
      requestedModel: input.requestedModel,
      availableModels,
    });
  }

  private async readAvailableModels(input: {
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly CodexModelCatalogEntry[] | null> {
    const entries: CodexModelCatalogEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const response = await this.send(
        "model/list",
        { cursor, limit: 100, includeHidden: true },
        input,
      );
      if (response.error) return null;
      const page = readCodexModelCatalogPage(response.result);
      if (!page) return null;
      entries.push(...page.data);
      if (entries.length > 500) return null;
      if (page.nextCursor === null) return entries.length === 0 ? null : entries;
      if (seenCursors.has(page.nextCursor)) return null;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return null;
  }

  async setGoal(input: {
    readonly threadId: string;
    readonly objective: string;
    readonly status: CodexThreadGoalStatus;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal> {
    const objectiveLimitError = appServerGoalObjectiveLimitError(input.objective);
    if (objectiveLimitError) {
      throw new Error(`codex_app_server_goal_set_failed:${objectiveLimitError}`);
    }
    const response = await this.send(
      "thread/goal/set",
      {
        threadId: input.threadId,
        objective: input.objective,
        status: input.status,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_set_failed:${formatGoalSetError(
          response.error.message,
          input.objective,
        )}`,
      );
    }
    const goal = readGoal(response.result?.goal);
    if (!goal) throw new Error("codex_app_server_goal_set_missing");
    return goal;
  }

  async getGoal(input: {
    readonly threadId: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal | null> {
    const response = await this.send(
      "thread/goal/get",
      {
        threadId: input.threadId,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_get_failed:${response.error.message ?? "unknown"}`,
      );
    }
    return readGoal(response.result?.goal);
  }

  async startTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly workspacePath: string;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
  }): Promise<AppServerTurnResult> {
    const disableTools = this.disableAllTools(input.goalMode);
    const disableNativeEnvironments = this.disableNativeEnvironments(input.goalMode);
    const response = await this.send(
      "turn/start",
      {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: [],
          },
        ],
        responsesapiClientMetadata: null,
        additionalContext: null,
        ...(disableTools || disableNativeEnvironments ? { environments: [] } : {}),
        cwd: null,
        runtimeWorkspaceRoots: null,
        approvalPolicy: this.approvalPolicyForThread(),
        approvalsReviewer: null,
        sandboxPolicy: this.sandboxPolicyFor(input),
        model: input.model,
        serviceTier: input.serviceTier ?? null,
        effort: input.reasoningEffort,
        summary: "none",
        personality: null,
        outputSchema: input.outputSchema ?? null,
        collaborationMode: null,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_turn_start_failed:${response.error.message ?? "unknown"}`,
      );
    }

    const turnId = nestedString(response.result, ["turn", "id"]);
    if (!turnId) throw new Error("codex_app_server_turn_id_missing");
    return this.waitForTurn(turnId, input);
  }

  private send(
    method: string,
    params: unknown,
    input: {
      readonly timeoutMs?: number;
      readonly abortSignal?: AbortSignal;
    } = {},
  ): Promise<CodexAppServerJsonRpcResponse> {
    if (!this.child) throw new Error("codex_app_server_not_started");
    throwIfAborted(input.abortSignal);
    if (this.terminalError) throw this.terminalError;
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = input.timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        input.abortSignal?.removeEventListener("abort", abort);
        reject(new Error(`codex_app_server_request_timeout:${method}`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`codex_app_server_aborted:${method}`));
      };
      input.abortSignal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          input.abortSignal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          input.abortSignal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      try {
        this.child!.stdin.write(encodeJsonRpcMessage({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("codex_app_server_write_failed"),
        );
      }
    });
  }

  private approvalPolicyForThread(): unknown {
    if (this.options.commandApprovalPolicy === undefined) return "never";
    return {
      granular: {
        mcp_elicitations: false,
        request_permissions: false,
        rules: true,
        sandbox_approval: true,
        skill_approval: false,
      },
    };
  }

  private disableAllTools(goalMode: boolean | undefined): boolean {
    return this.options.executionProfile.disableTools && goalMode !== true;
  }

  private disableNativeEnvironments(goalMode: boolean | undefined): boolean {
    return this.options.nativeToolSurface === "disabled" &&
      (goalMode === true || !this.disableAllTools(goalMode));
  }

  private sandboxPolicyFor(input: {
    readonly sandboxMode?: CodexSandboxMode;
    readonly workspacePath: string;
  }): CodexAppServerSandboxPolicy {
    return codexAppServerSandboxPolicy({
      ...input,
      sourceEnv: this.options.sourceEnv,
    });
  }

  private waitForTurn(
    turnId: string,
    input: {
      readonly threadId: string;
      readonly timeoutMs: number;
      readonly abortSignal: AbortSignal;
    },
  ): Promise<TurnState> {
    const earlyTurnId = this.earlyTurnIdsByThread.get(input.threadId);
    if (earlyTurnId) {
      this.earlyTurnIdsByThread.delete(input.threadId);
      this.aliasTurnId(earlyTurnId, turnId);
    }
    const existing = this.turns.get(turnId);
    if (existing?.completed || existing?.error) {
      this.clearTurnTracking(turnId, input.threadId);
      return Promise.resolve(existing);
    }
    if (this.terminalError) {
      return Promise.resolve({
        ...createTurnState(),
        error: this.terminalError,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearTurnTracking(turnId, input.threadId);
        input.abortSignal.removeEventListener("abort", abort);
        reject(new Error(`codex_app_server_turn_timeout:${turnId}`));
      }, input.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.clearTurnTracking(turnId, input.threadId);
        reject(new Error(`codex_app_server_turn_aborted:${turnId}`));
      };
      input.abortSignal.addEventListener("abort", abort, { once: true });
      const turn = existing ?? createTurnState();
      turn.waiters.push((state) => {
        clearTimeout(timer);
        input.abortSignal.removeEventListener("abort", abort);
        this.clearTurnTracking(turnId, input.threadId);
        resolve(state);
      });
      this.turns.set(turnId, turn);
      this.pendingTurnIdsByThread.set(input.threadId, turnId);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = parseJsonRpcLine(line);
      if (message === null) continue;
      this.onMessage(message);
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (
      typeof record.id === "number" &&
      ("result" in record || "error" in record)
    ) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      pending.resolve(record as CodexAppServerJsonRpcResponse);
      return;
    }

    const params = readRecord(record.params);
    if (typeof record.id === "number" && typeof record.method === "string") {
      this.onServerRequest(record.id, record.method, params);
      return;
    }

    if (typeof record.method !== "string") return;
    if (record.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const turn = this.ensureTurn(turnId);
      this.clearReconnectGraceTimer(turn);
      turn.outputText += stringField(params, "delta") ?? "";
      return;
    }
    if (record.method === "turn/started") {
      const threadId = stringField(params, "threadId");
      const turn = readRecord(params?.turn);
      const actualTurnId = stringField(turn, "id");
      const expectedTurnId = threadId
        ? this.pendingTurnIdsByThread.get(threadId)
        : undefined;
      if (actualTurnId && expectedTurnId && actualTurnId !== expectedTurnId) {
        this.aliasTurnId(actualTurnId, expectedTurnId);
      } else if (
        actualTurnId &&
        threadId &&
        !expectedTurnId &&
        !this.turnIdAliases.has(actualTurnId)
      ) {
        this.earlyTurnIdsByThread.set(threadId, actualTurnId);
      }
      return;
    }
    if (record.method === "item/completed") {
      const turnId = stringField(params, "turnId");
      const item = readRecord(params?.item);
      if (item?.type === "agentMessage") {
        const text = agentMessageText(item);
        if (text) {
          const turn = this.ensureTurn(turnId);
          this.clearReconnectGraceTimer(turn);
          turn.outputText = text;
        }
      }
      return;
    }
    if (record.method === "turn/completed") {
      const turn = readRecord(params?.turn);
      const turnId = stringField(turn, "id");
      const state = this.ensureTurn(turnId);
      state.completed = true;
      state.usage = mergeAgentUsage(
        state.usage,
        readUsageFromRecords(turn, params, record),
      );
      const status = readRecord(turn?.status);
      if (status?.type === "failed") {
        state.error = new Error(
          `codex_app_server_turn_failed:${safeMessage(
            turn?.error ?? status ?? params ?? record,
          )}`,
        );
      }
      this.resolveTurn(state);
      return;
    }
    if (record.method === "turn/aborted" || record.method === "turn_aborted") {
      const turnId =
        stringField(params, "turnId") ??
        stringField(params, "turn_id") ??
        stringField(readRecord(params?.turn), "id");
      const reason =
        stringField(params, "reason") ??
        stringField(readRecord(params?.status), "reason") ??
        "unknown";
      const error = new Error(
        `codex_app_server_turn_aborted:${reason}:${turnId ?? "unknown"}`,
      );
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
      return;
    }
    if (record.method === "error") {
      const turnId = stringField(params, "turnId");
      const message = safeMessage(params?.error ?? params ?? record);
      if (isCodexAppServerReconnectProgressMessage(message)) {
        this.deferTurnsForReconnectProgress(turnId, message);
        return;
      }
      const error = new Error(`codex_app_server_error:${message}`);
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
    }
  }

  private deferTurnsForReconnectProgress(
    turnId: string | null,
    message: string,
  ): void {
    const turns =
      turnId === null ? [...this.turns.values()] : [this.ensureTurn(turnId)];
    if (turns.length === 0) {
      this.backgroundWarnings.push({
        code: "codex_app_server_reconnecting",
        safeMessage: message,
      });
      return;
    }
    for (const turn of turns) {
      this.scheduleReconnectGraceTimeout(turn, message);
    }
  }

  private scheduleReconnectGraceTimeout(
    turn: TurnState,
    message: string,
  ): void {
    this.clearReconnectGraceTimer(turn);
    turn.reconnectGraceTimer = setTimeout(() => {
      if (turn.completed || turn.error) return;
      turn.error = new Error(
        `codex_app_server_reconnect_timeout:${safeMessage(message)}`,
      );
      this.resolveTurn(turn);
    }, this.options.reconnectGraceMs);
  }

  private onServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    if (this.tryHandleApprovalServerRequest(id, method, params)) return;
    this.serverRequests.push({
      code: "codex_app_server_unsupported_request",
      safeMessage: `Codex app-server requested unsupported client method: ${method}`,
    });
    this.respondServerRequestError(id, `unsupported_server_request:${method}`);
  }

  private tryHandleApprovalServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | null,
  ): boolean {
    if (method === "item/commandExecution/requestApproval") {
      const commandText = stringField(params, "command") ?? undefined;
      const cwd = stringField(params, "cwd") ?? undefined;
      const decision = this.reviewCommandApproval({
        source: "command_execution",
        ...(commandText === undefined ? {} : { commandText }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      this.respondServerRequest(id, {
        decision: decision.approved ? "accept" : "decline",
      });
      return true;
    }
    if (method === "execCommandApproval") {
      const command = stringArrayField(params, "command") ?? undefined;
      const cwd = stringField(params, "cwd") ?? undefined;
      const decision = this.reviewCommandApproval({
        source: "legacy_exec",
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      this.respondServerRequest(id, {
        decision: decision.approved ? "approved" : "denied",
      });
      return true;
    }
    if (method === "item/fileChange/requestApproval") {
      this.serverRequests.push({
        code: "codex_app_server_file_change_approval_denied",
        safeMessage:
          "Codex app-server requested file change approval; subscription-runtime denies provider-side file grants.",
      });
      this.respondServerRequest(id, { decision: "decline" });
      return true;
    }
    if (method === "applyPatchApproval") {
      this.serverRequests.push({
        code: "codex_app_server_apply_patch_approval_denied",
        safeMessage:
          "Codex app-server requested patch approval; subscription-runtime denies provider-side patch grants.",
      });
      this.respondServerRequest(id, { decision: "denied" });
      return true;
    }
    if (method === "item/permissions/requestApproval") {
      this.serverRequests.push({
        code: "codex_app_server_permission_request_denied",
        safeMessage:
          "Codex app-server requested additional permissions; subscription-runtime denies provider-side permission expansion.",
      });
      this.respondServerRequestError(
        id,
        "codex_app_server_permission_request_denied",
      );
      return true;
    }
    return false;
  }

  private reviewCommandApproval(
    input: CodexAppServerCommandApprovalInput,
  ): CodexAppServerCommandApprovalDecision {
    const policy = this.options.commandApprovalPolicy;
    const decision = policy?.reviewCommand(input) ?? {
      approved: false,
      reason: "approval_policy_not_configured",
    };
    if (!decision.approved) {
      this.serverRequests.push({
        code: "codex_app_server_command_approval_denied",
        safeMessage: `Codex app-server command approval denied: ${safeMessage(decision.reason ?? "unknown")}`,
      });
    }
    return decision;
  }

  private respondServerRequest(id: number, result: Record<string, unknown>): void {
    try {
      this.child?.stdin.write(encodeJsonRpcMessage({ id, result }));
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private respondServerRequestError(id: number, message: string): void {
    try {
      this.child?.stdin.write(
        encodeJsonRpcMessage({
          id,
          error: {
            code: -32000,
            message,
          },
        }),
      );
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private ensureTurn(turnId: string | null): TurnState {
    if (!turnId) return createTurnState();
    const canonicalTurnId = this.turnIdAliases.get(turnId) ?? turnId;
    let turn = this.turns.get(canonicalTurnId);
    if (!turn) {
      turn = createTurnState();
      this.turns.set(canonicalTurnId, turn);
    }
    return turn;
  }

  private resolveTurn(turn: TurnState): void {
    this.clearReconnectGraceTimer(turn);
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }

  private failOutstanding(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      turn.error = error;
      this.resolveTurn(turn);
    }
    this.pendingTurnIdsByThread.clear();
    this.earlyTurnIdsByThread.clear();
    this.turnIdAliases.clear();
  }

  private recordTerminalError(error: Error): void {
    this.terminalError = this.terminalError ?? error;
    this.failOutstanding(this.terminalError);
  }

  private clearTurnTracking(turnId: string, threadId: string): void {
    this.turns.delete(turnId);
    this.pendingTurnIdsByThread.delete(threadId);
    this.earlyTurnIdsByThread.delete(threadId);
    this.deleteTurnAliases(turnId);
  }

  private deleteTurnAliases(turnId: string): void {
    for (const [actualTurnId, expectedTurnId] of this.turnIdAliases) {
      if (actualTurnId === turnId || expectedTurnId === turnId) {
        this.turnIdAliases.delete(actualTurnId);
      }
    }
  }

  private aliasTurnId(actualTurnId: string, expectedTurnId: string): void {
    if (actualTurnId === expectedTurnId) return;
    this.turnIdAliases.set(actualTurnId, expectedTurnId);
    const actual = this.turns.get(actualTurnId);
    if (!actual) return;
    const expected = this.turns.get(expectedTurnId);
    if (expected) {
      expected.outputText += actual.outputText;
      expected.completed = expected.completed || actual.completed;
      expected.error = expected.error ?? actual.error;
      expected.waiters.push(...actual.waiters);
      if (expected.completed || expected.error) {
        this.resolveTurn(expected);
      }
    } else {
      this.turns.set(expectedTurnId, actual);
    }
    this.turns.delete(actualTurnId);
  }

  private clearReconnectGraceTimer(turn: TurnState): void {
    if (!turn.reconnectGraceTimer) return;
    clearTimeout(turn.reconnectGraceTimer);
    turn.reconnectGraceTimer = null;
  }
}

function createTurnState(): TurnState {
  return {
    outputText: "",
    usage: undefined,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}
