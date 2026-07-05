import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskResult,
  type SessionArtifact,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexAuthJsonFromArtifact } from "./codex-auth-json-codec";
import { pruneCodexChildEnv } from "./codex-cli-domain";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import { composeCodexPrompt } from "./codex-prompt-composer";
import { codexSandboxModeForControls } from "./codex-json-execution-engine";
import {
  codexAgentCapabilities,
  codexAgentId,
  codexProviderId,
  defaultCodexModel,
} from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";

export type CodexCliAgentDriverOptions = {
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

export class CodexCliAgentDriver implements AgentDriver {
  readonly agentId = codexAgentId;
  readonly providerId = codexProviderId;
  readonly capabilities = codexAgentCapabilities;

  constructor(private readonly options: CodexCliAgentDriverOptions = {}) {}

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: Parameters<AgentDriver["runTask"]>[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    if (!input.session) {
      return {
        status: "failed",
        failure: {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Codex requires a session artifact.",
        },
        warnings: [],
      };
    }

    const authJson = codexAuthJsonFromArtifact(input.session);
    input.redactor.registerSecret(authJson, "codex-auth-json");

    const tempRoot = await createCodexRuntimeTempRoot({
      prefix: "subscription-runtime-codex-",
      sourceEnv: this.options.sourceEnv,
    });
    const tempHome = join(tempRoot, "home");
    const tempCodexHome = join(tempRoot, "codex-home");
    await mkdir(tempHome, { recursive: true, mode: 0o700 });
    await mkdir(tempCodexHome, { recursive: true, mode: 0o700 });

    try {
      const sandboxMode = codexSandboxModeForControls(input.task.controls);
      await writeCodexHomeSnapshot({
        codexHome: tempCodexHome,
        authJson,
        sandboxMode,
      });
      const result = await input.runner.run({
        command: this.options.codexBinaryPath ?? "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          sandboxMode,
          "--model",
          this.options.model ?? defaultCodexModel,
          // Verified with codex-cli 0.139.0: `codex exec -- -` reads the prompt from stdin.
          "--",
          "-",
        ],
        cwd: input.workspace.path,
        env: {
          ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
          HOME: tempHome,
          CODEX_HOME: tempCodexHome,
          CI: "true",
        },
        stdin: new TextEncoder().encode(
          composeCodexPrompt({
            prompt: input.task.prompt,
            systemPrompt: input.task.systemPrompt,
          }),
        ),
        timeoutMs: this.options.timeoutMs ?? this.capabilities.maxRuntimeMs,
        abortSignal: input.abortSignal,
      });

      const stdout = input.redactor.redact(result.stdout);
      const stderr = input.redactor.redact(result.stderr);
      input.redactor.assertNoKnownSecret(stdout, "codex-agent-stdout");
      input.redactor.assertNoKnownSecret(stderr, "codex-agent-stderr");

      if (result.exitCode !== 0) {
        return {
          status: "failed",
          failure: this.classifyRunFailure({
            exitCode: result.exitCode,
            stdout,
            stderr,
          }),
          warnings: [],
        };
      }

      return {
        status: "completed",
        outputText: stdout,
        warnings: [],
      };
    } finally {
      await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome });
    }
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }
}

async function writeCodexHomeSnapshot(input: {
  readonly codexHome: string;
  readonly authJson: string;
  readonly sandboxMode: ReturnType<typeof codexSandboxModeForControls>;
}): Promise<void> {
  const config = [
    'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(input.sandboxMode)}`,
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
  ].join("\n");
  await writeFile(join(input.codexHome, "config.toml"), config, {
    mode: 0o600,
  });
  await writeFile(join(input.codexHome, "auth.json"), input.authJson, {
    mode: 0o600,
  });
}
