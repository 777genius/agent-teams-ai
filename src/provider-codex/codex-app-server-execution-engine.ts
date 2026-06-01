import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter, once as onceEvent } from "node:events";
import type {
  RedactorPort,
  RunnerPort,
} from "@777genius/subscription-runtime/core";
import { pruneCodexChildEnv } from "./codex-cli-domain";
import type {
  CodexExecutionProfile,
  ResolvedCodexExecutionProfile,
} from "./codex-execution-profile";
import { resolveCodexExecutionProfile } from "./codex-execution-profile";
import type {
  CodexExecutionEngine,
  CodexExecutionPrewarmResult,
  CodexExecutionResult,
  CodexMaterializedSession,
  CodexReasoningEffort,
} from "./codex-json-execution-engine";

export type CodexAppServerExecutionEngineOptions = {
  readonly codexBinaryPath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly fallback?: CodexExecutionEngine;
  readonly processFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
};

export type CodexAppServerProcessFactory = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) => CodexAppServerChildProcess;

export type CodexAppServerChildProcess = {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string | Uint8Array): boolean;
    end(): void;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  sessionHash: string | null;
};

type AppServerWarning = {
  readonly code: string;
  readonly safeMessage: string;
};

type PreparedThread = {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
};

const defaultTimeoutMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;

export class CodexAppServerExecutionEngine implements CodexExecutionEngine {
  readonly kind = "app-server-pool" as const;
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;

  private readonly executionProfile: ResolvedCodexExecutionProfile;

  private readonly slots = new Map<string, AppServerSlot>();

  constructor(private readonly options: CodexAppServerExecutionEngineOptions) {
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_app_server_binary_required");
    }
    this.executionProfile = resolveCodexExecutionProfile(
      options.executionProfile,
    );
  }

  async run(input: {
    readonly prompt: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    try {
      const result = await this.runViaAppServer(input);
      if (input.outputSchema) {
        return {
          ...result,
          structuredOutput: parseStructuredOutput(result.outputText),
        };
      }
      return result;
    } catch (error) {
      await this.disposeSessionSlot(input.session);
      if (input.abortSignal.aborted || isAbortLikeError(error)) throw error;
      if (!this.options.fallback) throw error;

      const fallbackResult = await this.options.fallback.run(input);
      return {
        ...fallbackResult,
        warnings: [appServerFallbackWarning(error), ...fallbackResult.warnings],
      };
    }
  }

  async dispose(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(slots.map((slot) => slot.client.stop()));
    await this.options.fallback?.dispose?.();
  }

  async prewarm(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly warmupPrompt?: string;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionPrewarmResult> {
    try {
      const slot = await this.ensureSlot(input);
      const warmupPrompt = input.warmupPrompt?.trim();
      const warnings: AppServerWarning[] = [];
      if (warmupPrompt) {
        const result = await slot.client.runCleanTurn({
          prompt: warmupPrompt,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
          prepareNext: false,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(
          outputText,
          "codex-app-server-prewarm-output",
        );
        assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
        warnings.push(...result.warnings);
      }

      warnings.push(
        ...(await slot.client.prewarmCleanThread({
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
        })),
      );
      return {
        kind: this.kind,
        reusable: true,
        warmedAt: new Date(),
        warnings,
      };
    } catch (error) {
      await this.disposeSessionSlot(input.session);
      throw error;
    }
  }

  private async runViaAppServer(input: {
    readonly prompt: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    const slot = await this.ensureSlot(input);
    const result = await slot.client.runCleanTurn({
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    });

    const outputText = input.redactor.redact(result.outputText);
    input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
    assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
    return {
      outputText,
      warnings: result.warnings,
    };
  }

  private async ensureSlot(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<AppServerSlot> {
    const key = input.session.codexHome;
    const sessionHash = input.session.sessionHash ?? null;
    const existing = this.slots.get(key);
    if (existing && existing.sessionHash === sessionHash) {
      return existing;
    }

    if (existing) {
      await existing.client.stop();
      this.slots.delete(key);
    }

    const client = new CodexAppServerClient({
      codexBinaryPath: this.options.codexBinaryPath,
      sourceEnv: this.options.sourceEnv ?? {},
      processFactory: this.options.processFactory ?? spawnCodexAppServerProcess,
      session: input.session,
      workspacePath: input.workspacePath,
      executionProfile: this.executionProfile,
      cleanThreadPrewarm: this.options.cleanThreadPrewarm ?? true,
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    });
    await client.start();
    const slot = { key, client, sessionHash };
    this.slots.set(key, slot);
    return slot;
  }

  private async disposeSessionSlot(
    session: CodexMaterializedSession,
  ): Promise<void> {
    const slot = this.slots.get(session.codexHome);
    if (!slot) return;
    this.slots.delete(session.codexHome);
    await slot.client.stop();
  }
}

type JsonRpcResponse = {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};

type TurnState = {
  outputText: string;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
};

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

class CodexAppServerClient {
  private nextId = 1;
  private child: CodexAppServerChildProcess | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private readonly serverRequests: AppServerWarning[] = [];
  private readonly backgroundWarnings: AppServerWarning[] = [];
  private preparedThread: PreparedThread | null = null;
  private prepareThreadInFlight: Promise<void> | null = null;
  private exited = false;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly session: CodexMaterializedSession;
      readonly workspacePath: string;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs: number;
      readonly abortSignal: AbortSignal;
    },
  ) {}

  async start(): Promise<void> {
    this.exited = false;
    const env = {
      ...pruneCodexChildEnv(this.options.sourceEnv),
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
      const error = new Error(`codex_app_server_exited:${code ?? signal}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const turn of this.turns.values()) {
        turn.error = error;
        this.resolveTurn(turn);
      }
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });

    const response = await this.send("initialize", {
      clientInfo: {
        name: "subscription-runtime",
        title: "ReviewRouter subscription runtime",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    if (response.error) {
      throw new Error(
        `codex_app_server_initialize_failed:${response.error.message ?? "unknown"}`,
      );
    }
  }

  async runCleanTurn(input: {
    readonly prompt: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly prepareNext?: boolean;
  }): Promise<{
    readonly outputText: string;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const warnings = this.drainWarnings();
    const preparedThread = this.takePreparedThread(input);
    const threadId =
      preparedThread?.threadId ?? (await this.startThread(input));
    const turn = await this.startTurn({ ...input, threadId }).catch(
      async (error: unknown) => {
        if (!preparedThread) throw error;
        warnings.push({
          code: "codex_app_server_prepared_thread_failed",
          safeMessage:
            "Codex app-server prepared thread failed; retried with a fresh thread.",
        });
        const retryThreadId = await this.startThread(input);
        return await this.startTurn({ ...input, threadId: retryThreadId });
      },
    );
    if (turn.error) throw turn.error;
    if (!turn.outputText.trim()) {
      throw new Error("codex_app_server_final_message_missing");
    }
    if (input.prepareNext ?? true) {
      this.prepareCleanThreadBestEffort(input);
    }
    warnings.push(...this.drainWarnings());
    return {
      outputText: turn.outputText,
      warnings,
    };
  }

  async prewarmCleanThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly AppServerWarning[]> {
    if (!this.cleanThreadPrewarmEnabled()) return [];
    try {
      await this.prepareCleanThreadNow(input);
      return this.drainWarnings();
    } catch (error) {
      return [cleanThreadPrewarmWarning(error)];
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (this.exited) return;
    signalChildGroup(child, "SIGTERM");
    const timeout = setTimeout(() => {
      signalChildGroup(child, "SIGKILL");
    }, 5_000);
    try {
      await onceEvent(child as unknown as EventEmitter, "exit");
    } catch {
      // Best-effort shutdown.
    } finally {
      clearTimeout(timeout);
      signalChildGroup(child, "SIGKILL");
    }
  }

  private drainWarnings(): AppServerWarning[] {
    const warnings = [...this.backgroundWarnings, ...this.serverRequests];
    this.backgroundWarnings.length = 0;
    this.serverRequests.length = 0;
    return warnings;
  }

  private takePreparedThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
  }): PreparedThread | null {
    const prepared = this.preparedThread;
    if (!prepared) return null;
    this.preparedThread = null;
    if (
      prepared.workspacePath !== input.workspacePath ||
      prepared.model !== input.model ||
      prepared.reasoningEffort !== input.reasoningEffort
    ) {
      this.backgroundWarnings.push({
        code: "codex_app_server_prepared_thread_discarded",
        safeMessage:
          "Codex app-server discarded a prepared thread because the next task used a different runtime context.",
      });
      return null;
    }
    return prepared;
  }

  private prepareCleanThreadBestEffort(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): void {
    if (!this.cleanThreadPrewarmEnabled() || input.abortSignal.aborted) return;
    void this.prepareCleanThreadNow(input).catch((error: unknown) => {
      this.backgroundWarnings.push(cleanThreadPrewarmWarning(error));
    });
  }

  private async prepareCleanThreadNow(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void> {
    if (!this.cleanThreadPrewarmEnabled()) return;
    if (this.preparedThread && this.preparedThreadMatches(input)) return;
    if (this.prepareThreadInFlight) return await this.prepareThreadInFlight;

    this.prepareThreadInFlight = this.startThread(input)
      .then((threadId) => {
        this.preparedThread = {
          threadId,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        };
      })
      .finally(() => {
        this.prepareThreadInFlight = null;
      });
    await this.prepareThreadInFlight;
  }

  private preparedThreadMatches(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
  }): boolean {
    return (
      this.preparedThread?.workspacePath === input.workspacePath &&
      this.preparedThread.model === input.model &&
      this.preparedThread.reasoningEffort === input.reasoningEffort
    );
  }

  private cleanThreadPrewarmEnabled(): boolean {
    return this.options.cleanThreadPrewarm ?? true;
  }

  private async startThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<string> {
    const response = await this.send(
      "thread/start",
      {
        model: input.model,
        modelProvider: null,
        serviceTier: null,
        cwd: input.workspacePath,
        runtimeWorkspaceRoots: [input.workspacePath],
        approvalPolicy: "never",
        approvalsReviewer: null,
        sandbox: "read-only",
        permissions: null,
        config: {
          model_reasoning_effort: input.reasoningEffort,
          model_verbosity: "low",
          approval_policy: "never",
          sandbox_mode: "read-only",
          web_search: "disabled",
          features: {
            apps: false,
            hooks: false,
            memories: false,
            multi_agent: false,
            shell_snapshot: false,
            skill_mcp_dependency_install: false,
          },
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
        developerInstructions:
          this.options.executionProfile.developerInstructions,
        personality: null,
        ephemeral: true,
        sessionStartSource: "startup",
        threadSource: "user",
        environments: [],
        dynamicTools: [],
        experimentalRawEvents: false,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`,
      );
    }

    const threadId = nestedString(response.result, ["thread", "id"]);
    if (!threadId) throw new Error("codex_app_server_thread_id_missing");
    return threadId;
  }

  private async startTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<TurnState> {
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
        environments: [],
        cwd: null,
        runtimeWorkspaceRoots: null,
        approvalPolicy: "never",
        approvalsReviewer: null,
        sandboxPolicy: null,
        permissions: null,
        model: input.model,
        serviceTier: null,
        effort: input.reasoningEffort,
        summary: "none",
        personality: null,
        outputSchema: null,
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
  ): Promise<JsonRpcResponse> {
    if (!this.child) throw new Error("codex_app_server_not_started");
    throwIfAborted(input.abortSignal);
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex_app_server_request_timeout:${method}`));
      }, input.timeoutMs ?? this.options.timeoutMs);
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
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private waitForTurn(
    turnId: string,
    input: {
      readonly timeoutMs: number;
      readonly abortSignal: AbortSignal;
    },
  ): Promise<TurnState> {
    const existing = this.turns.get(turnId);
    if (existing?.completed || existing?.error)
      return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        reject(new Error(`codex_app_server_turn_timeout:${turnId}`));
      }, input.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.turns.delete(turnId);
        reject(new Error(`codex_app_server_turn_aborted:${turnId}`));
      };
      input.abortSignal.addEventListener("abort", abort, { once: true });
      const turn = existing ?? createTurnState();
      turn.waiters.push((state) => {
        clearTimeout(timer);
        input.abortSignal.removeEventListener("abort", abort);
        this.turns.delete(turnId);
        resolve(state);
      });
      this.turns.set(turnId, turn);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
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
      pending.resolve(record as JsonRpcResponse);
      return;
    }

    if (typeof record.id === "number" && typeof record.method === "string") {
      this.onServerRequest(record.id, record.method);
      return;
    }

    if (typeof record.method !== "string") return;
    const params = readRecord(record.params);
    if (record.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const turn = this.ensureTurn(turnId);
      turn.outputText += stringField(params, "delta") ?? "";
      return;
    }
    if (record.method === "item/completed") {
      const turnId = stringField(params, "turnId");
      const item = readRecord(params?.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.ensureTurn(turnId).outputText = item.text;
      }
      return;
    }
    if (record.method === "turn/completed") {
      const turn = readRecord(params?.turn);
      const turnId = stringField(turn, "id");
      const state = this.ensureTurn(turnId);
      state.completed = true;
      const status = readRecord(turn?.status);
      if (status?.type === "failed") {
        state.error = new Error("codex_app_server_turn_failed");
      }
      this.resolveTurn(state);
      return;
    }
    if (record.method === "error") {
      const turnId = stringField(params, "turnId");
      const error = new Error(
        `codex_app_server_error:${safeMessage(params?.error ?? params ?? record)}`,
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
    }
  }

  private onServerRequest(id: number, method: string): void {
    this.serverRequests.push({
      code: "codex_app_server_unsupported_request",
      safeMessage: `Codex app-server requested unsupported client method: ${method}`,
    });
    this.child?.stdin.write(
      `${JSON.stringify({
        id,
        error: {
          code: -32000,
          message: `unsupported_server_request:${method}`,
        },
      })}\n`,
    );
  }

  private ensureTurn(turnId: string | null): TurnState {
    if (!turnId) return createTurnState();
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = createTurnState();
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private resolveTurn(turn: TurnState): void {
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }
}

function spawnCodexAppServerProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): CodexAppServerChildProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  return child;
}

function createTurnState(): TurnState {
  return {
    outputText: "",
    completed: false,
    error: null,
    waiters: [],
  };
}

function appServerFallbackWarning(error: unknown): AppServerWarning {
  return {
    code: "codex_app_server_fallback",
    safeMessage: `Codex app-server failed; used codex exec fallback: ${safeMessage(error)}`,
  };
}

function cleanThreadPrewarmWarning(error: unknown): AppServerWarning {
  return {
    code: "codex_app_server_clean_thread_prewarm_failed",
    safeMessage: `Codex app-server clean thread prewarm failed: ${safeMessage(error)}`,
  };
}

function signalChildGroup(
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform === "win32" || !child.pid) {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}

function nestedString(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    const record = readRecord(current);
    current = record?.[segment];
  }
  return typeof current === "string" ? current : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

function parseStructuredOutput(outputText: string): unknown {
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw new Error("codex_app_server_structured_output_invalid", {
      cause: error,
    });
  }
}

function assertOutputWithinBounds(
  output: string,
  maxOutputBytes = defaultMaxOutputBytes,
): void {
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
    throw new Error("codex_app_server_output_too_large");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("codex_app_server_aborted");
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("codex_app_server_aborted") ||
      error.message.includes("codex_app_server_turn_aborted") ||
      error.message.includes("node_process_runner_aborted"))
  );
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(-1000);
  if (typeof error === "string") return error.slice(-1000);
  const record = readRecord(error);
  if (typeof record?.message === "string") return record.message.slice(-1000);
  const nested = record ? readRecord(record.error) : null;
  if (typeof nested?.message === "string") return nested.message.slice(-1000);
  return "unknown";
}
