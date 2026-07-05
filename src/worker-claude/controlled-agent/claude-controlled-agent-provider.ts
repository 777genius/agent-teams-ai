import { spawn } from "node:child_process";
import {
  DefaultRedactor,
  type ProcessResult,
  type RedactorPort,
  type RunnerPort,
  type SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeCliTaskExecutionEngine,
  ClaudeTaskAgentDriver,
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
  type ClaudeTaskExecutionEngine,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  ControlledAgentRunStatus,
  type ControlledAgentProviderPort,
  type ControlledAgentProviderStartInput,
  type ControlledAgentProviderStartResult,
  type ControlledAgentProviderStatusInput,
  type ControlledAgentProviderStatusResult,
  type ControlledAgentProviderStopInput,
  type ControlledAgentProviderStopResult,
} from "@vioxen/subscription-runtime/worker-core";
import type { ClaudeControlledAgentProfile } from "./claude-controlled-agent-profile";

export type ClaudeControlledAgentProviderOptions = {
  readonly profile: ClaudeControlledAgentProfile;
  readonly sessionArtifact: SessionArtifact;
  readonly workspacePath: string;
  readonly claudePath?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly engine?: ClaudeTaskExecutionEngine;
  readonly runner?: RunnerPort;
  readonly redactor?: RedactorPort;
  readonly controllerObjective?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
};

type ActiveClaudeControllerRun = {
  readonly abortController: AbortController;
  readonly driver: ClaudeTaskAgentDriver;
  status: ControlledAgentRunStatus;
  safeMessage?: string;
  completedAt?: string;
};

export class ClaudeControlledAgentProvider implements ControlledAgentProviderPort {
  private readonly runs = new Map<string, ActiveClaudeControllerRun>();

  constructor(private readonly options: ClaudeControlledAgentProviderOptions) {}

  start(input: ControlledAgentProviderStartInput): ControlledAgentProviderStartResult {
    const providerRunId = `${input.session.sessionId}:claude-cli`;
    if (this.runs.has(providerRunId)) {
      return {
        providerRunId,
        safeMessage: "Claude controlled-agent run is already active.",
      };
    }

    const abortController = new AbortController();
    const redactor = this.options.redactor ?? new DefaultRedactor();
    const driver = this.createDriver();
    const active: ActiveClaudeControllerRun = {
      abortController,
      driver,
      status: ControlledAgentRunStatus.Running,
    };
    this.runs.set(providerRunId, active);

    void driver.runTask({
      session: claudeSessionWithConfigDir(
        this.options.sessionArtifact,
        this.options.profile.configDir,
      ),
      task: {
        kind: "structured-prompt",
        prompt: controlledAgentPrompt(input, this.options.controllerObjective),
        systemPrompt: input.systemPrompt,
        controls: {
          editMode: "allow-edits",
          allowedTools: this.options.profile.allowedTools,
          disallowedTools: this.options.profile.disallowedTools,
          ...(this.options.maxTurns === undefined
            ? {}
            : { maxTurns: this.options.maxTurns }),
        },
        metadata: {
          subscriptionRuntimeControlledRunId: providerRunId,
        },
      },
      workspace: {
        path: this.options.workspacePath,
      },
      runner: this.options.runner ?? new ClaudeControlledAgentProcessRunner(),
      redactor,
      abortSignal: abortController.signal,
    }).then((result) => {
      active.status = result.status === "completed"
        ? ControlledAgentRunStatus.Completed
        : result.status === "waiting_for_input"
        ? ControlledAgentRunStatus.Blocked
        : ControlledAgentRunStatus.Failed;
      active.safeMessage = result.status === "completed"
        ? "Claude controlled-agent goal completed."
        : result.status === "waiting_for_input"
        ? "Claude controlled-agent is waiting for input."
        : result.failure.safeMessage;
      active.completedAt = new Date().toISOString();
    }).catch((error: unknown) => {
      active.status = abortController.signal.aborted
        ? ControlledAgentRunStatus.Stopped
        : ControlledAgentRunStatus.Failed;
      active.safeMessage = error instanceof Error ? error.message : String(error);
      active.completedAt = new Date().toISOString();
    });

    return {
      providerRunId,
      safeMessage:
        "Claude controlled-agent CLI run started with strict MCP broker tools.",
    };
  }

  status(
    input: ControlledAgentProviderStatusInput,
  ): ControlledAgentProviderStatusResult {
    const providerRunId = input.run.providerRunId ?? providerRunIdFor(input);
    const active = this.runs.get(providerRunId);
    if (!active) {
      return {
        status: ControlledAgentRunStatus.Stale,
        providerRunId,
        safeMessage: "Claude controlled-agent run is not active in this process.",
        observedAt: new Date().toISOString(),
      };
    }
    return {
      status: active.status,
      providerRunId,
      ...(active.safeMessage === undefined ? {} : {
        safeMessage: active.safeMessage,
      }),
      observedAt: active.completedAt ?? new Date().toISOString(),
    };
  }

  async stop(
    input: ControlledAgentProviderStopInput,
  ): Promise<ControlledAgentProviderStopResult> {
    const providerRunId = input.run.providerRunId ?? providerRunIdFor(input);
    const active = this.runs.get(providerRunId);
    if (!active) {
      return {
        status: ControlledAgentRunStatus.Failed,
        safeMessage: "Claude controlled-agent run is not active in this process.",
        stoppedAt: new Date().toISOString(),
      };
    }
    active.abortController.abort();
    await active.driver.dispose();
    active.status = ControlledAgentRunStatus.Stopped;
    active.safeMessage = input.reason ?? "stopped";
    active.completedAt = new Date().toISOString();
    this.runs.delete(providerRunId);
    return {
      status: ControlledAgentRunStatus.Stopped,
      safeMessage: active.safeMessage,
      stoppedAt: active.completedAt,
    };
  }

  private createDriver(): ClaudeTaskAgentDriver {
    return new ClaudeTaskAgentDriver({
      engine: this.options.engine ?? new ClaudeCliTaskExecutionEngine({
        ...(this.options.claudePath === undefined
          ? {}
          : { claudePath: this.options.claudePath }),
        ...(this.options.baseEnv === undefined
          ? {}
          : { baseEnv: this.options.baseEnv }),
      }),
      appendSystemPrompt: this.options.profile.appendSystemPrompt,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
      allowedTools: this.options.profile.allowedTools,
      disallowedTools: this.options.profile.disallowedTools,
      mcpConfig: [this.options.profile.mcpConfig],
      strictMcpConfig: this.options.profile.strictMcpConfig,
    });
  }
}

function claudeSessionWithConfigDir(
  artifact: SessionArtifact,
  configDir: string,
): SessionArtifact {
  const validation = validateClaudeSessionArtifact(artifact);
  return sessionArtifactFromClaudeOAuth({
    oauthToken: validation.session.oauthToken,
    configDir,
    ...(validation.session.refreshedAt === undefined
      ? {}
      : { refreshedAt: validation.session.refreshedAt }),
    ...(validation.session.expiresAt === undefined
      ? {}
      : { expiresAt: validation.session.expiresAt }),
    ...(validation.session.metadata === undefined
      ? {}
      : { metadata: validation.session.metadata }),
  });
}

class ClaudeControlledAgentProcessRunner implements RunnerPort {
  readonly runnerId = "claude-controlled-agent-process-runner";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process" as const,
  };

  async run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<ProcessResult> {
    if (input.abortSignal.aborted) throw new Error("claude_controlled_runner_aborted");
    const startedAt = Date.now();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(terminate, input.timeoutMs);
    const abort = () => terminate();
    input.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });
      if (input.abortSignal.aborted) throw new Error("claude_controlled_runner_aborted");
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
      };
      if (exitCode !== 0) {
        throw new Error(
          `claude_controlled_runner_failed:${exitCode}:${safeFailureOutput(result)}`,
        );
      }
      return result;
    } finally {
      clearTimeout(timeout);
      input.abortSignal.removeEventListener("abort", abort);
    }
  }
}

function safeFailureOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return output.length <= 1000 ? output : output.slice(-1000);
}

function controlledAgentPrompt(
  input: ControlledAgentProviderStartInput,
  controllerObjective?: string,
): string {
  return [
    "Start the project controller loop.",
    `Controller job: ${input.session.identity.controllerJobId}.`,
    `Project: ${input.session.identity.projectId}.`,
    ...(controllerObjective === undefined
      ? []
      : [
          "",
          "Controller objective from the project manifest:",
          controllerObjective,
          "",
        ]),
    "Use only the broker/status MCP tools available in this session.",
    "Do not request raw shell, raw git, raw tmux, filesystem grants or auth files.",
  ].join("\n");
}

function providerRunIdFor(input: {
  readonly session: { readonly sessionId: string };
}): string {
  return `${input.session.sessionId}:claude-cli`;
}
