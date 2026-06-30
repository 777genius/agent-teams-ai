import type {
  ProviderTaskControls,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "./claude-task-agent-driver";

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
    assertReadOnlyToolPolicy(input.permissionMode, input.allowedTools);

    const warnings = unsupportedWarnings(input);
    const result = await input.runner.run({
      command: this.options.claudePath ?? "claude",
      args: this.args(input),
      cwd: input.workspacePath,
      env: this.env(input),
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
        : { structuredOutput: parseStructuredJson(stdout) }),
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
      mapPermissionMode(input.permissionMode),
    ];
    if (input.appendSystemPrompt !== undefined) {
      args.push("--append-system-prompt", input.appendSystemPrompt);
    }
    if (input.allowedTools !== undefined) {
      args.push("--allowedTools", input.allowedTools.join(","));
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

  private env(input: ClaudeTaskEngineInput): Readonly<Record<string, string>> {
    const configDir = input.session.configDir;
    return definedEnv({
      ...pruneClaudeChildEnv(this.options.baseEnv ?? process.env),
      HOME: configDir,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_OAUTH_TOKEN: input.session.oauthToken,
      CI: "true",
    });
  }
}

const defaultTimeoutMs = 30 * 60 * 1000;

function mapPermissionMode(
  mode: ProviderTaskControls["permissionMode"] | undefined,
): string {
  if (mode === "allow-edits") return "acceptEdits";
  if (mode === "bypass") return "bypassPermissions";
  if (mode === "read-only" || mode === "preapproved") return "dontAsk";
  return "default";
}

function assertReadOnlyToolPolicy(
  permissionMode: ProviderTaskControls["permissionMode"] | undefined,
  allowedTools: readonly string[] | undefined,
): void {
  if (permissionMode !== "read-only" || allowedTools === undefined) return;
  const unsafe = allowedTools.filter((tool) => !isReadOnlyClaudeTool(tool));
  if (unsafe.length === 0) return;
  throw new Error(
    `claude_read_only_allowed_tools_unsafe:${unsafe.join(",")}`,
  );
}

const readOnlyClaudeTools = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
  "WebFetch",
]);

function isReadOnlyClaudeTool(tool: string): boolean {
  const name = tool.split("(", 1)[0]?.trim();
  return name !== undefined && readOnlyClaudeTools.has(name);
}

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

function parseStructuredJson(outputText: string): unknown {
  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error("claude_structured_output_invalid");
  }
}

function assertOutputWithinBounds(
  output: string,
  maxOutputBytes = 2 * 1024 * 1024,
): void {
  if (Buffer.byteLength(output, "utf8") <= maxOutputBytes) return;
  throw new Error("claude_output_too_large");
}

function pruneClaudeChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const allowed = new Set([
    "CI",
    "LANG",
    "LC_ALL",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) =>
      value !== undefined &&
      (allowed.has(key) || key.startsWith("LC_"))
    ),
  );
}

function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
}

function preview(value: string): string {
  return value.length <= 1000 ? value : `${value.slice(-1000)}`;
}
