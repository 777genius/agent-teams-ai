import type {
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
} from "@vioxen/subscription-runtime/core";
import type {
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import { controlRequestTimeoutMs } from "../domain/app-server-errors";
import {
  buildGoalResumePrompt,
  goalInputRequest,
  goalMaxTurnsExceededError,
  normalizeRunId,
} from "../domain/app-server-goal-policy";
import {
  type AppServerRunResult,
  type AppServerWarning,
  type CodexThreadGoal,
} from "../domain/app-server-types";
import {
  mergeAgentUsage,
  preferredUsage,
  usageField,
} from "../domain/app-server-usage";
import type { CodexAppServerClient } from "./app-server-client";
import { turnFailureError } from "./app-server-client";
import {
  assertManagedRunCanResume,
  managedRunFailureFromError,
} from "./app-server-managed-run-mapper";

export class AppServerGoalRunner {
  constructor(
    private readonly options: {
      readonly client: CodexAppServerClient;
      readonly runStore: ManagedRunStorePort;
    },
  ) {}

  async runGoal(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
  }): Promise<AppServerRunResult> {
    const warnings = this.options.client.drainWarnings();
    const runId = normalizeRunId(input.runId);
    const threadId = await this.options.client.startThread({
      ...input,
      goalMode: true,
    });
    await this.options.client.setGoal({
      threadId,
      objective: input.goalObjective ?? input.prompt,
      status: "active",
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
    });

    return this.continueGoal({
      ...input,
      runId,
      threadId,
      firstPrompt: input.prompt,
      warnings,
    });
  }

  async resumeGoal(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly skipResumeValidation?: boolean;
  }): Promise<AppServerRunResult> {
    const threadId = input.resumeHandle.threadId;
    if (!threadId) throw new Error("codex_managed_run_thread_missing");
    if (!input.skipResumeValidation) {
      await assertManagedRunCanResume({
        runStore: this.options.runStore,
        runId: input.runId,
        requestId: input.requestId,
        resumeHandle: input.resumeHandle,
        workspacePath: input.workspacePath,
      });
    }
    await this.options.runStore.resume({
      runId: input.runId,
      requestId: input.requestId,
      answer: input.answer,
      now: new Date(),
    });

    try {
      return await this.continueGoal({
        ...input,
        threadId,
        firstPrompt: buildGoalResumePrompt(input),
        warnings: this.options.client.drainWarnings(),
      });
    } catch (error) {
      await this.options.runStore.fail({
        runId: input.runId,
        failure: managedRunFailureFromError(error),
        now: new Date(),
      });
      throw error;
    }
  }

  private async continueGoal(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly firstPrompt: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly warnings: AppServerWarning[];
  }): Promise<AppServerRunResult> {
    let outputText = "";
    let turnUsage: AgentUsage | undefined;
    let goalUsage: AgentUsage | undefined;
    for (
      let turnNumber = 1;
      turnNumber <= input.maxGoalTurns;
      turnNumber += 1
    ) {
      const startedAt = Date.now();
      const turn = await this.options.client
        .startTurn({
          ...input,
          goalMode: true,
          turnNumber,
          prompt:
            turnNumber === 1 ? input.firstPrompt : input.goalContinuePrompt,
        })
        .catch((error: unknown) => {
          throw turnFailureError(error, {
            phase: "turn_start_rejected",
            turnNumber,
            elapsedMs: Date.now() - startedAt,
          });
        });
      if (turn.error) throw turn.error;
      outputText = turn.outputText;
      turnUsage = mergeAgentUsage(turnUsage, turn.usage);

      const goal = await this.options.client.getGoal({
        threadId: input.threadId,
        timeoutMs: controlRequestTimeoutMs(input.timeoutMs),
        abortSignal: input.abortSignal,
      });
      if (!goal) {
        throw new Error("codex_app_server_goal_missing");
      }
      goalUsage = mergeAgentUsage(goalUsage, goal.usage);
      if (goal.status === "complete") {
        input.warnings.push(...this.options.client.drainWarnings());
        await this.options.runStore.complete({
          runId: input.runId,
          outputText,
          now: new Date(),
        });
        return {
          status: "completed",
          outputText,
          ...usageField(preferredUsage(turnUsage, goalUsage)),
          warnings: input.warnings,
        };
      }
      if (goal.status === "blocked" || goal.status === "paused") {
        return this.waitForGoalInput({
          runId: input.runId,
          threadId: input.threadId,
          goal,
          outputText,
          workspacePath: input.workspacePath,
          ...usageField(preferredUsage(turnUsage, goalUsage)),
          warnings: input.warnings,
        });
      }
      if (goal.status !== "active") {
        throw new Error(`codex_app_server_goal_${goal.status}`);
      }
      if (!outputText.trim()) {
        throw new Error("codex_app_server_goal_turn_output_missing");
      }
    }

    throw goalMaxTurnsExceededError({
      maxGoalTurns: input.maxGoalTurns,
      outputText,
    });
  }

  private async waitForGoalInput(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly goal: CodexThreadGoal;
    readonly outputText: string;
    readonly workspacePath: string;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }): Promise<{
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const request = goalInputRequest({
      runId: input.runId,
      goal: input.goal,
      outputText: input.outputText,
    });
    const resumeHandle: ManagedRunResumeHandle = {
      runId: input.runId,
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      providerState: {
        goalObjective: input.goal.objective,
        goalStatus: input.goal.status,
      },
    };
    await this.options.runStore.saveWaitingInput({
      runId: input.runId,
      request,
      resumeHandle,
      ...(input.outputText.trim() ? { outputText: input.outputText } : {}),
      now: new Date(),
    });
    return {
      status: "waiting_for_input",
      runId: input.runId,
      outputText: input.outputText.trim() ? input.outputText : request.question,
      request,
      resumeHandle,
      ...usageField(input.usage),
      warnings: input.warnings,
    };
  }
}
