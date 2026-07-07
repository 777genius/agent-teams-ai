import type {
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  assertClaudeReadOnlyToolPolicy,
  mapClaudePermissionMode,
} from "../protocol/claude-permission-policy";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "../task/engine-contract";
import { claudeCliChildEnv } from "./claude-cli-env";

export type ClaudeCliTaskExecutionEngineOptions = {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly claudePath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export class ClaudeCliTaskExecutionEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "claude-cli-print" as const;
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: false,
    supportsProviderRunId: false,
    supportsCleanup: true,
  } as const;

  constructor(private readonly options: ClaudeCliTaskExecutionEngineOptions = {}) {}

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    if (!input.session.configDir) throw new Error("claude_config_dir_required");
    assertClaudeReadOnlyToolPolicy(input.editMode, input.allowedTools);

    const warnings = unsupportedWarnings(input);
    const result = await input.runner.run({
      command: this.options.claudePath ?? "claude",
      args: this.args(input),
      cwd: input.workspacePath,
      env: claudeCliChildEnv({
        baseEnv: this.options.baseEnv ?? process.env,
        configDir: input.session.configDir,
        oauthToken: input.session.oauthToken,
      }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    });

    const stdout = input.redactor.redact(result.stdout.trim());
    const stderr = input.redactor.redact(result.stderr.trim());
    input.redactor.assertNoKnownSecret(stdout, "claude-cli-stdout");
    input.redactor.assertNoKnownSecret(stderr, "claude-cli-stderr");
    assertOutputWithinBounds(stdout, this.options.maxOutputBytes);
    assertOutputWithinBounds(stderr, this.options.maxOutputBytes);

    if (stderr.length > 0) {
      warnings.push({
        code: "claude_cli_stderr",
        safeMessage: "Claude CLI wrote diagnostics to stderr.",
        details: { stderrPreview: preview(stderr) },
      });
    }

    return {
      outputText: stdout,
      ...(input.outputSchemaName === undefined
        ? {}
        : { structuredOutput: parseCliStructuredJson(stdout) }),
      telemetry: {
        durationMs: result.durationMs,
      } satisfies ProviderTaskTelemetry,
      warnings,
    };
  }

  private args(input: ClaudeTaskEngineInput): readonly string[] {
    const args = [
      "--print",
      "--safe-mode",
      "--no-session-persistence",
      "--output-format",
      "text",
      "--model",
      input.model,
      "--permission-mode",
      mapClaudePermissionMode(input.editMode, input.providerSandboxMode),
    ];
    if (input.appendSystemPrompt !== undefined) {
      args.push("--append-system-prompt", input.appendSystemPrompt);
    }
    if (input.allowedTools !== undefined) {
      args.push("--allowedTools", input.allowedTools.join(","));
    }
    if (input.disallowedTools !== undefined) {
      args.push("--disallowedTools", input.disallowedTools.join(","));
    }
    if (input.mcpConfig !== undefined) {
      args.push("--mcp-config", ...input.mcpConfig);
    }
    if (input.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
    args.push(input.prompt);
    return args;
  }
}

const defaultTimeoutMs = 30 * 60 * 1000;

function unsupportedWarnings(input: ClaudeTaskEngineInput): RuntimeWarning[] {
  const warnings: RuntimeWarning[] = [];
  if (input.maxTurns !== undefined) {
    warnings.push({
      code: "claude_cli_max_turns_unsupported",
      safeMessage: "Claude CLI print engine does not support maxTurns.",
    });
  }
  return warnings;
}

function assertOutputWithinBounds(
  output: string,
  maxOutputBytes = 2 * 1024 * 1024,
): void {
  if (Buffer.byteLength(output, "utf8") <= maxOutputBytes) return;
  throw new Error("claude_output_too_large");
}

function parseCliStructuredJson(outputText: string): unknown {
  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error("claude_structured_output_invalid");
  }
}

function preview(value: string): string {
  return value.length <= 1000 ? value : `${value.slice(-1000)}`;
}
