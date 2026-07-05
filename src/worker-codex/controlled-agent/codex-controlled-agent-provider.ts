import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DefaultRedactor,
  type ProcessResult,
  type RedactorPort,
  type RunnerPort,
  type SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
  sessionArtifactHash,
  type CodexAppServerProcessFactory,
  type CodexMaterializedSession,
  type CodexReasoningEffort,
  type CodexServiceTier,
  type CodexSessionMaterializer,
  writeCodexJsonHomeSnapshot,
} from "@vioxen/subscription-runtime/provider-codex";
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
import type { CodexControlledAgentProfile } from "./codex-controlled-agent-profile";

export type CodexControlledAgentProviderOptions = {
  readonly profile: CodexControlledAgentProfile;
  readonly sessionArtifact: SessionArtifact;
  readonly workspacePath: string;
  readonly codexBinaryPath: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly processFactory?: CodexAppServerProcessFactory;
  readonly redactor?: RedactorPort;
  readonly controllerObjective?: string;
  readonly maxGoalTurns?: number;
};

type ActiveCodexControllerRun = {
  readonly abortController: AbortController;
  readonly driver: CodexJsonAgentDriver;
  status: ControlledAgentRunStatus;
  safeMessage?: string;
  completedAt?: string;
};

export class CodexControlledAgentProvider implements ControlledAgentProviderPort {
  private readonly runs = new Map<string, ActiveCodexControllerRun>();

  constructor(private readonly options: CodexControlledAgentProviderOptions) {}

  start(input: ControlledAgentProviderStartInput): ControlledAgentProviderStartResult {
    const providerRunId = `${input.session.sessionId}:codex-app-server`;
    if (this.runs.has(providerRunId)) {
      return {
        providerRunId,
        safeMessage: "Codex controlled-agent run is already active.",
      };
    }

    const abortController = new AbortController();
    const redactor = this.options.redactor ?? new DefaultRedactor();
    const driver = this.createDriver();
    const active: ActiveCodexControllerRun = {
      abortController,
      driver,
      status: ControlledAgentRunStatus.Running,
    };
    this.runs.set(providerRunId, active);

    void driver.runTask({
      session: this.options.sessionArtifact,
      task: {
        kind: "structured-prompt",
        prompt: controlledAgentPrompt(input, this.options.controllerObjective),
        systemPrompt: input.systemPrompt,
        controls: {
          editMode: "read-only",
        },
        metadata: {
          codexGoalObjective: this.options.controllerObjective ??
            controlledAgentGoalObjective(input),
          codexManagedRunId: providerRunId,
        },
      },
      workspace: {
        path: this.options.workspacePath,
      },
      runner: noShellRunner,
      redactor,
      abortSignal: abortController.signal,
    }).then((result) => {
      active.status = result.status === "completed"
        ? ControlledAgentRunStatus.Completed
        : result.status === "waiting_for_input"
        ? ControlledAgentRunStatus.Blocked
        : ControlledAgentRunStatus.Failed;
      active.safeMessage = result.status === "completed"
        ? "Codex controlled-agent goal completed."
        : result.status === "waiting_for_input"
        ? "Codex controlled-agent is waiting for input."
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
        "Codex controlled-agent app-server goal started with native environments disabled.",
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
        safeMessage: "Codex controlled-agent run is not active in this process.",
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
        safeMessage: "Codex controlled-agent run is not active in this process.",
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

  private createDriver(): CodexJsonAgentDriver {
    return new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: this.options.codexBinaryPath,
        ...(this.options.processFactory === undefined
          ? {}
          : { processFactory: this.options.processFactory }),
        goalMode: true,
        nativeToolSurface: this.options.profile.appServerNativeToolSurface,
        cleanThreadPrewarm: false,
        ...(this.options.maxGoalTurns === undefined
          ? {}
          : { maxGoalTurns: this.options.maxGoalTurns }),
      }),
      sessionMaterializer: new ControlledCodexSessionMaterializer({
        profile: this.options.profile,
      }),
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.options.reasoningEffort }),
      ...(this.options.serviceTier === undefined
        ? {}
        : { serviceTier: this.options.serviceTier }),
    });
  }
}

class ControlledCodexSessionMaterializer implements CodexSessionMaterializer {
  readonly mode = "worker-cache" as const;

  constructor(private readonly options: {
    readonly profile: CodexControlledAgentProfile;
  }) {}

  async materialize(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    const authJson = codexAuthJsonFromArtifact(input.session);
    input.redactor.registerSecret(authJson, "codex-auth-json");
    const home = join(this.options.profile.codexHome, "..", "home");
    const codexHome = this.options.profile.codexHome;
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeCodexJsonHomeSnapshot({ codexHome, authJson });
    await writeFile(
      join(codexHome, "config.toml"),
      this.options.profile.configToml,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(codexHome, "controlled-agent-rules.txt"),
      this.options.profile.rulesText,
      { encoding: "utf8", mode: 0o600 },
    );
    return {
      home,
      codexHome,
      sessionHash: sessionArtifactHash(input.session),
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
      },
      snapshotSession: async () =>
        sessionArtifactFromCodexAuthJson(await readFile(join(codexHome, "auth.json"), "utf8")),
      release: async () => undefined,
    };
  }
}

const noShellRunner: RunnerPort = {
  runnerId: "codex-controlled-agent-no-shell-runner",
  capabilities: {
    runnerId: "codex-controlled-agent-no-shell-runner",
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process",
  },
  run(): Promise<ProcessResult> {
    throw new Error("controlled_agent_raw_runner_forbidden");
  },
};

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

function controlledAgentGoalObjective(input: ControlledAgentProviderStartInput): string {
  return [
    "Act as the live broker-only project controller.",
    `Controller job: ${input.session.identity.controllerJobId}.`,
    `Project: ${input.session.identity.projectId}.`,
    "Inspect project worker status, create scoped child workers when useful, review outputs, and integrate only through brokered lifecycle tools.",
    "Never use raw shell/git/tmux/registry/auth access.",
  ].join(" ");
}

function providerRunIdFor(input: {
  readonly session: { readonly sessionId: string };
}): string {
  return `${input.session.sessionId}:codex-app-server`;
}
