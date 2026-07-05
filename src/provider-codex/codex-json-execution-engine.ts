import type {
  AgentUsage,
  ProviderTaskControls,
  ProviderTaskResult,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  RedactorPort,
  RunnerPort,
  SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import { classifyCodexFailure } from "./failure-classifier";
import { pruneCodexChildEnv } from "./codex-cli-domain";
import { composeCodexPrompt } from "./codex-prompt-composer";
import { parseCodexStructuredOutput } from "./structured-output";

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type CodexServiceTier = string;

export type CodexOutputSchemaRequest = {
  readonly name: string;
  readonly schema?: unknown;
};

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexMaterializedSession = {
  readonly home: string;
  readonly codexHome: string;
  readonly sessionHash?: string;
  readonly env: Readonly<Record<string, string>>;
  snapshotSession?(): Promise<SessionArtifact | null>;
  release(): Promise<void>;
};

export type CodexExecutionWarning = {
  readonly code: string;
  readonly safeMessage: string;
};

export type CodexExecutionCompletedResult = {
  readonly status?: "completed";
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly usage?: AgentUsage;
  readonly warnings: readonly CodexExecutionWarning[];
};

export type CodexExecutionWaitingForInputResult = {
  readonly status: "waiting_for_input";
  readonly runId: string;
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly request: ManagedRunInputRequest;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly usage?: AgentUsage;
  readonly warnings: readonly CodexExecutionWarning[];
};

export type CodexExecutionResult =
  | CodexExecutionCompletedResult
  | CodexExecutionWaitingForInputResult;

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
  }): Promise<CodexExecutionResult>;
  resume?(input: {
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
  }): Promise<CodexExecutionResult>;
  prewarm?(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
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
    const schemaFile = await writeOutputSchemaFile(input.outputSchema);
    try {
      const args = buildCodexJsonExecArgs({
        jsonFlag: this.options.jsonFlag ?? "--json",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        ...(input.serviceTier === undefined
          ? {}
          : { serviceTier: input.serviceTier }),
        ...(input.sandboxMode === undefined
          ? {}
          : { sandboxMode: input.sandboxMode }),
        ...(schemaFile === null ? {} : { outputSchemaPath: schemaFile.path }),
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
        stdin: new TextEncoder().encode(
          composeCodexPrompt({
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
          }),
        ),
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
        throw Object.assign(new Error(
          `codex_json_exec_failed:${result.exitCode}:${safeTail(`${stdout}\n${stderr}`)}`,
        ), {
          exitCode: result.exitCode,
          stdout,
          stderr,
        });
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
    } finally {
      await schemaFile?.dispose();
    }
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
  readonly serviceTier?: CodexServiceTier;
  readonly sandboxMode?: CodexSandboxMode;
  readonly outputSchemaPath?: string;
}): readonly string[] {
  return [
    "exec",
    input.jsonFlag,
    "--model",
    input.model,
    "--sandbox",
    input.sandboxMode ?? "read-only",
    "--config",
    'approval_policy="never"',
    "--config",
    `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    ...(input.serviceTier
      ? [
          "--config",
          `service_tier=${JSON.stringify(input.serviceTier)}`,
          ...(input.serviceTier === "fast"
            ? ["--config", "features.fast_mode=true"]
            : []),
        ]
      : []),
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
    ...(input.outputSchemaPath ? ["--output-schema", input.outputSchemaPath] : []),
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-",
  ];
}

async function writeOutputSchemaFile(
  outputSchema: unknown,
): Promise<{ readonly path: string; dispose(): Promise<void> } | null> {
  const schema = codexOutputSchemaPayload(outputSchema);
  if (schema === undefined) return null;
  const dir = await createCodexRuntimeTempRoot({
    prefix: "subscription-runtime-codex-schema-",
  });
  const path = join(dir, "schema.json");
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    path,
    async dispose() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function codexOutputSchemaPayload(outputSchema: unknown): unknown | undefined {
  if (outputSchema === undefined || outputSchema === null) return undefined;
  if (typeof outputSchema !== "object") return outputSchema;
  if ("schema" in outputSchema) {
    return (outputSchema as CodexOutputSchemaRequest).schema;
  }
  if (
    "type" in outputSchema ||
    "$schema" in outputSchema ||
    "properties" in outputSchema
  ) {
    return outputSchema;
  }
  return undefined;
}

export function codexSandboxModeForControls(
  controls: Pick<
    ProviderTaskControls,
    "editMode" | "providerSandboxMode"
  > | undefined,
): CodexSandboxMode {
  assertProviderSandboxModeAllowed(controls);
  if (controls?.providerSandboxMode !== undefined) {
    return controls.providerSandboxMode;
  }
  if (controls?.editMode === "allow-edits") return "workspace-write";
  return "read-only";
}

function assertProviderSandboxModeAllowed(
  controls: Pick<
    ProviderTaskControls,
    "editMode" | "providerSandboxMode"
  > | undefined,
): void {
  if (
    controls?.providerSandboxMode === undefined ||
    controls.editMode === "allow-edits"
  ) {
    return;
  }
  throw new Error("codex_provider_sandbox_mode_requires_allow_edits");
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
  const type = typeof record.type === "string" ? record.type : null;
  if (!hasAssistantRole(record)) return null;
  if (type === "item.completed") {
    const item = record.item;
    return item && typeof item === "object"
      ? extractTextFromRecord(item as Record<string, unknown>)
      : null;
  }
  if (type === "response.completed") {
    const response = record.response;
    return response && typeof response === "object"
      ? extractTextFromRecord(response as Record<string, unknown>)
      : null;
  }
  if (type && !isAssistantTextEventType(type)) return null;
  return extractTextFromRecord(record);
}

function isAssistantTextEventType(type: string): boolean {
  return (
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "message" ||
    type === "result"
  );
}

function extractTextFromRecord(record: Record<string, unknown>): string | null {
  for (const key of [
    "message",
    "text",
    "output_text",
    "last_message",
    "content",
    "output",
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
      .map((entry) => stringifyContentEntry(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (!isAssistantContentRecord(record)) return null;
    return stringifyContent(
      record.text ?? record.output_text ?? record.content ?? record.output,
    );
  }
  return null;
}

function stringifyContentEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (!isAssistantContentRecord(record)) return null;
  return stringifyContent(
    record.text ?? record.output_text ?? record.content ?? record.output,
  );
}

function isAssistantContentRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
  if (!hasAssistantRole(record)) return false;
  return (
    !type ||
    type === "agentMessage" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "message" ||
    type === "output_text" ||
    type === "text"
  );
}

function hasAssistantRole(record: Record<string, unknown>): boolean {
  const role = record.role;
  return typeof role !== "string" || role === "assistant";
}

function parseStructuredOutput(outputText: string): unknown {
  return parseCodexStructuredOutput(
    outputText,
    "codex_structured_output_invalid",
  );
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
