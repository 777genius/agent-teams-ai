import type {
  ProviderTaskResult,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { classifyCodexFailure } from "./failure-classifier";
import { pruneCodexChildEnv } from "./codex-cli-domain";

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type CodexMaterializedSession = {
  readonly home: string;
  readonly codexHome: string;
  readonly sessionHash?: string;
  readonly env: Readonly<Record<string, string>>;
  release(): Promise<void>;
};

export type CodexExecutionResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export type CodexExecutionPrewarmResult = {
  readonly kind: string;
  readonly reusable: boolean;
  readonly warmedAt: Date;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export type CodexExecutionEngine = {
  readonly kind: string;
  readonly capabilities: {
    readonly supportsStructuredOutput: boolean;
    readonly supportsJsonEvents: boolean;
    readonly supportsThreadResume: boolean;
    readonly requiresSchemaFile: boolean;
  };
  run(input: {
    readonly prompt: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult>;
  prewarm?(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly warmupPrompt?: string;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionPrewarmResult>;
  dispose?(): Promise<void>;
};

export type PackagedCodexJsonExecutionEngineOptions = {
  readonly codexBinaryPath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly jsonFlag?: "--json" | "--experimental-json";
  readonly maxOutputBytes?: number;
};

const defaultTimeoutMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;

export class PackagedCodexJsonExecutionEngine implements CodexExecutionEngine {
  readonly kind = "packaged-json" as const;
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;

  constructor(
    private readonly options: PackagedCodexJsonExecutionEngineOptions,
  ) {
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_packaged_binary_required");
    }
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
    const args = buildCodexJsonExecArgs({
      jsonFlag: this.options.jsonFlag ?? "--json",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    const result = await input.runner.run({
      command: this.options.codexBinaryPath,
      args,
      cwd: input.workspacePath,
      env: {
        ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
        ...input.session.env,
        CI: "true",
      },
      stdin: new TextEncoder().encode(input.prompt),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
    });

    const stdout = input.redactor.redact(result.stdout);
    const stderr = input.redactor.redact(result.stderr);
    input.redactor.assertNoKnownSecret(stdout, "codex-json-stdout");
    input.redactor.assertNoKnownSecret(stderr, "codex-json-stderr");
    assertOutputWithinBounds(stdout, this.options.maxOutputBytes);
    assertOutputWithinBounds(stderr, this.options.maxOutputBytes);

    if (result.exitCode !== 0) {
      throw new Error(
        `codex_json_exec_failed:${result.exitCode}:${safeTail(`${stdout}\n${stderr}`)}`,
      );
    }

    const outputText = extractFinalAssistantText(stdout);
    if (input.outputSchema) {
      return {
        outputText,
        structuredOutput: parseStructuredOutput(outputText),
        warnings: [],
      };
    }

    return {
      outputText,
      warnings: [],
    };
  }

  async prewarm(): Promise<CodexExecutionPrewarmResult> {
    return {
      kind: this.kind,
      reusable: false,
      warmedAt: new Date(),
      warnings: [
        {
          code: "codex_packaged_exec_prewarm_skipped",
          safeMessage:
            "Packaged Codex exec starts a fresh process for every task.",
        },
      ],
    };
  }
}

export function buildCodexJsonExecArgs(input: {
  readonly jsonFlag: "--json" | "--experimental-json";
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
}): readonly string[] {
  return [
    "exec",
    input.jsonFlag,
    "--model",
    input.model,
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--config",
    `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    "--config",
    'model_verbosity="low"',
    "--config",
    'web_search="disabled"',
    "--config",
    "features.apps=false",
    "--config",
    "features.hooks=false",
    "--config",
    "features.memories=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.shell_snapshot=false",
    "--config",
    "features.skill_mcp_dependency_install=false",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-",
  ];
}

export function codexExecutionFailure(
  error: unknown,
): Extract<ProviderTaskResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    failure: classifyCodexFailure(error),
    warnings: [],
  };
}

function extractFinalAssistantText(stdout: string): string {
  let finalText: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch (error) {
      if (looksLikeJsonLine(trimmed)) {
        throw new Error("codex_json_event_invalid", { cause: error });
      }
      continue;
    }

    const text = extractTextFromEvent(event);
    if (text) {
      finalText = text;
    }
  }

  if (!finalText) {
    throw new Error("codex_json_final_message_missing");
  }
  return finalText;
}

function looksLikeJsonLine(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function extractTextFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  for (const key of [
    "message",
    "text",
    "output_text",
    "last_message",
    "content",
  ]) {
    const value = record[key];
    const text = stringifyContent(value);
    if (text) return text;
  }

  for (const key of ["data", "item", "delta", "response"]) {
    const nested = extractTextFromEvent(record[key]);
    if (nested) return nested;
  }
  return null;
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          return stringifyContent(record.text ?? record.content);
        }
        return null;
      })
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

function parseStructuredOutput(outputText: string): unknown {
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw new Error("codex_structured_output_invalid", { cause: error });
  }
}

function assertOutputWithinBounds(
  output: string,
  maxOutputBytes = defaultMaxOutputBytes,
): void {
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
    throw new Error("codex_json_output_too_large");
  }
}

function safeTail(value: string): string {
  return value.slice(-4096);
}
