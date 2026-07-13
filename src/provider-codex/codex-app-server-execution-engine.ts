import type {
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
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
  CodexSandboxMode,
  CodexServiceTier,
} from "./codex-json-execution-engine";
import { codexOutputSchemaPayload } from "./codex-json-execution-engine";
import { InMemoryManagedRunStore } from "./codex-app-server-managed-run-store";
import type {
  CodexAppServerChildProcess,
  CodexAppServerProcessFactory,
} from "./app-server/application/app-server-process-port";
import {
  signalCodexAppServerChildGroup,
  spawnCodexAppServerProcess,
} from "./app-server/adapters/node-app-server-process";
import type {
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
} from "./app-server/domain/app-server-types";
import {
  defaultGoalContinuePrompt,
  defaultMaxGoalTurns,
  defaultMaxOutputBytes,
  defaultTimeoutMs,
  type AppServerRunResult,
  type AppServerWarning,
} from "./app-server/domain/app-server-types";
import {
  appServerOutputSchemaNotNativeWarning,
  assertOutputWithinBounds,
  assertPositiveInteger,
  isAbortLikeError,
  parseStructuredOutput,
} from "./app-server/domain/app-server-errors";
import {
  appServerFallbackWarning,
  isAppServerWaitingForInputResult,
  redactWaitingForInputResult,
} from "./app-server/application/app-server-fallback-policy";
import {
  assertManagedRunCanResume,
  failManagedRunForProviderOutput,
  isManagedRunResumeValidationError,
} from "./app-server/application/app-server-managed-run-mapper";
import { AppServerSlotPool } from "./app-server/application/app-server-slot-pool";
import { isCodexModelUnavailableError } from "./app-server/domain/model-catalog";

export type {
  CodexAppServerChildProcess,
  CodexAppServerProcessFactory,
};
export type {
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
};

export type CodexAppServerExecutionEngineOptions = {
  readonly codexBinaryPath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly fallback?: CodexExecutionEngine;
  readonly processFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
  readonly reconnectGraceMs?: number;
  readonly goalMode?: boolean;
  readonly maxGoalTurns?: number;
  readonly goalContinuePrompt?: string;
  readonly runStore?: ManagedRunStorePort;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
};

export class CodexAppServerExecutionEngine implements CodexExecutionEngine {
  readonly kind: "app-server-pool" | "app-server-goal";
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;

  private readonly executionProfile: ResolvedCodexExecutionProfile;
  private readonly runStore: ManagedRunStorePort;
  private readonly slotPool: AppServerSlotPool;

  constructor(private readonly options: CodexAppServerExecutionEngineOptions) {
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_app_server_binary_required");
    }
    assertPositiveInteger(options.timeoutMs, "codex_app_server_timeout_invalid");
    assertPositiveInteger(
      options.startupTimeoutMs,
      "codex_app_server_startup_timeout_invalid",
    );
    this.kind = options.goalMode ? "app-server-goal" : "app-server-pool";
    this.executionProfile = resolveCodexExecutionProfile(
      options.executionProfile,
    );
    this.runStore = options.runStore ?? new InMemoryManagedRunStore();
    this.slotPool = new AppServerSlotPool({
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
      processFactory: options.processFactory ?? spawnCodexAppServerProcess,
      signalChildProcess: signalCodexAppServerChildGroup,
      runStore: this.runStore,
      executionProfile: this.executionProfile,
      ...(options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: options.commandApprovalPolicy }),
      ...(options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: options.nativeToolSurface }),
      cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.reconnectGraceMs === undefined
        ? {}
        : { reconnectGraceMs: options.reconnectGraceMs }),
    });
  }

  async run(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    try {
      const result = await this.runViaAppServer(input);
      if (result.status === "waiting_for_input") return result;
      return await this.parseStructuredOutputIfRequested(result, input);
    } catch (error) {
      await this.slotPool.disposeSessionSlot(input.session);
      if (input.abortSignal.aborted || isAbortLikeError(error)) throw error;
      if (isCodexModelUnavailableError(error)) throw error;
      if (!this.options.fallback) throw error;

      const fallbackResult = await this.options.fallback.run(input);
      return {
        ...fallbackResult,
        warnings: [appServerFallbackWarning(error), ...fallbackResult.warnings],
      };
    }
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    try {
      const result = await this.resumeViaAppServer(input);
      if (result.status === "waiting_for_input") return result;
      return await this.parseStructuredOutputIfRequested(result, input);
    } catch (error) {
      if (!isManagedRunResumeValidationError(error)) {
        await this.slotPool.disposeSessionSlot(input.session);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.slotPool.dispose();
    await this.options.fallback?.dispose?.();
  }

  async prewarm(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly warmupPrompt?: string;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionPrewarmResult> {
    try {
      const slot = await this.slotPool.ensureSlot(input);
      const warmupPrompt = input.warmupPrompt?.trim();
      const warnings: AppServerWarning[] = [];
      if (warmupPrompt) {
        const result = await slot.turnRunner.runCleanTurn({
          prompt: warmupPrompt,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          sandboxMode: "read-only",
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
          prepareNext: false,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(
          outputText,
          "codex-app-server-prewarm-output",
        );
        assertOutputWithinBounds(outputText, this.maxOutputBytes());
        warnings.push(...result.warnings);
      }

      warnings.push(
        ...(await slot.turnRunner.prewarmCleanThread({
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
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
      await this.slotPool.disposeSessionSlot(input.session);
      throw error;
    }
  }

  private async runViaAppServer(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    const slot = await this.slotPool.ensureSlot(input);
    const outputSchema = codexOutputSchemaPayload(input.outputSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const common = {
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      prompt: input.prompt,
      ...(input.goalObjective !== undefined
        ? { goalObjective: input.goalObjective }
        : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    };
    const result = this.options.goalMode
      ? await slot.goalRunner.runGoal({
          ...common,
          maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
          goalContinuePrompt:
            this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
        })
      : await slot.turnRunner.runCleanTurn(common);
    return this.redactAppServerResult({
      result,
      schemaWarnings,
      redactor: input.redactor,
    });
  }

  private async resumeViaAppServer(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    if (!this.options.goalMode) {
      throw new Error("codex_app_server_resume_requires_goal_mode");
    }
    await assertManagedRunCanResume({
      runStore: this.runStore,
      runId: input.runId,
      requestId: input.requestId,
      resumeHandle: input.resumeHandle,
      workspacePath: input.workspacePath,
    });
    const slot = await this.slotPool.ensureSlot(input);
    const outputSchema = codexOutputSchemaPayload(input.outputSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const result = await slot.goalRunner.resumeGoal({
      runId: input.runId,
      requestId: input.requestId,
      answer: input.answer,
      resumeHandle: input.resumeHandle,
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
      maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
      goalContinuePrompt:
        this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
      skipResumeValidation: true,
    });
    return this.redactAppServerResult({
      result,
      schemaWarnings,
      redactor: input.redactor,
    });
  }

  private redactAppServerResult(input: {
    readonly result: AppServerRunResult;
    readonly schemaWarnings: readonly AppServerWarning[];
    readonly redactor: RedactorPort;
  }): CodexExecutionResult {
    const outputText = input.redactor.redact(input.result.outputText);
    input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
    assertOutputWithinBounds(outputText, this.maxOutputBytes());
    if (isAppServerWaitingForInputResult(input.result)) {
      return redactWaitingForInputResult({
        result: input.result,
        outputText,
        redactor: input.redactor,
      });
    }
    return {
      outputText,
      ...(input.result.usage === undefined ? {} : { usage: input.result.usage }),
      warnings: [...input.schemaWarnings, ...input.result.warnings],
    };
  }

  private async parseStructuredOutputIfRequested(
    result: CodexExecutionResult,
    input: {
      readonly runId?: string;
      readonly outputSchema?: unknown;
    },
  ): Promise<CodexExecutionResult> {
    if (!input.outputSchema) return result;
    try {
      return {
        ...result,
        structuredOutput: parseStructuredOutput(result.outputText),
      };
    } catch (error) {
      await failManagedRunForProviderOutput({
        goalMode: this.options.goalMode,
        runId: input.runId,
        runStore: this.runStore,
      });
      throw error;
    }
  }

  private maxOutputBytes(): number {
    return this.options.maxOutputBytes ?? defaultMaxOutputBytes;
  }
}
