#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentTaskProtocolVersion,
  agentTaskRequestToProviderTask,
  makeFailedAgentTaskResult,
  parseAgentTaskRequest,
  providerTaskResultToAgentTaskResult,
  type AgentTaskEvent,
  type AgentTaskRequest,
  type AgentTaskResult,
} from "@vioxen/subscription-runtime/agent-task";
import type {
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import {
  isSubscriptionWorkerError,
} from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendClaudeWorker,
} from "../../worker-claude/file-backend-claude-worker";
import {
  FileBackendCodexWorker,
} from "../../worker-codex/file-backend-codex-worker";
import {
  pruneClaudeChildEnv,
  resolveRequestCwd,
} from "./domain";
import {
  RuntimeAgentTaskProvider,
} from "./ports";
import type {
  ProviderName,
  RuntimeAgentTaskWorker,
  RuntimeAgentTaskWorkerFactory,
  RuntimeAgentTaskWorkerFactoryInput,
  RuntimeAgentTaskWorkerResult,
} from "./ports";

export {
  pruneClaudeChildEnv,
  resolveRequestCwd,
} from "./domain";
export {
  RuntimeAgentTaskProvider,
} from "./ports";
export type {
  ProviderName,
  RuntimeAgentTaskWorker,
  RuntimeAgentTaskWorkerFactory,
  RuntimeAgentTaskWorkerFactoryInput,
  RuntimeAgentTaskWorkerJob,
  RuntimeAgentTaskWorkerResult,
} from "./ports";

export type SubscriptionAgentTaskCliIo = {
  readStdin(): Promise<string>;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
};

type ParsedArgs = {
  readonly provider: ProviderName;
  readonly inputPath?: string;
  readonly format: "event-ndjson" | "result-json";
  readonly stateRootDir?: string;
  readonly providerInstanceId?: string;
  readonly encryptionKeyEnv: string;
  readonly ephemeral: boolean;
  readonly claudeTokenEnv: string;
  readonly codexAuthJsonPath?: string;
  readonly codexAuthJsonEnv: string;
  readonly claudePath?: string;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
};

export async function runSubscriptionAgentTaskCli(
  argv = process.argv.slice(2),
  io: SubscriptionAgentTaskCliIo = defaultIo,
  workerFactory: RuntimeAgentTaskWorkerFactory = createDefaultWorker,
): Promise<number> {
  let tempStateRoot: string | null = null;
  try {
    const args = parseArgs(argv);
    const request = parseAgentTaskRequest(
      JSON.parse(
        args.inputPath ? await readFile(args.inputPath, "utf8") : await io.readStdin(),
      ),
    );
    const cwd = await resolveRequestCwd(io.cwd(), request.cwd ?? ".");
    const env = io.env();
    const workerEnv = args.provider === RuntimeAgentTaskProvider.Claude
      ? pruneClaudeChildEnv(env)
      : env;
    const stateRootDir =
      args.stateRootDir ??
      (args.ephemeral
        ? (tempStateRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-agent-task-")))
        : env.SUBSCRIPTION_RUNTIME_STATE_ROOT);
    if (!stateRootDir) {
      throw new Error(
        "--state-root is required unless --ephemeral or SUBSCRIPTION_RUNTIME_STATE_ROOT is set",
      );
    }

    const encryptionKey = args.ephemeral
      ? randomBytes(32)
      : requiredEnv(env, args.encryptionKeyEnv);
    const providerInstanceId =
      args.providerInstanceId ??
      request.providerInstanceId ??
      `${args.provider}:default`;
    const timeoutMs = args.timeoutMs ?? request.timeoutMs;

    const worker = workerFactory({
      provider: args.provider,
      stateRootDir,
      providerInstanceId,
      encryptionKey,
      cwd,
      env: workerEnv,
      ...(args.model ? { model: args.model } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(args.claudePath ? { claudePath: args.claudePath } : {}),
      ...(env.CLAUDE_RUNTIME_DIST_DIR
        ? { claudeRuntimeDistDir: env.CLAUDE_RUNTIME_DIST_DIR }
        : {}),
      ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
    });

    try {
      const result = await runWorkerTaskWithTimeout({
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        run: async (abortSignal) => {
          await worker.start();
          throwIfAborted(abortSignal);
          await seedWorker({ args, env, worker });
          throwIfAborted(abortSignal);
          return await runWorkerTask({ request, worker, abortSignal });
        },
      });
      await emitResult({ request, result, format: args.format, io });
      return result.status === "completed" ? 0 : 1;
    } finally {
      await disposeWorker({
        worker,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        io,
      });
    }
  } catch (error) {
    const safeMessage =
      error instanceof Error ? error.message : "subscription runtime agent task failed";
    if (requestedOutputFormat(argv) === "result-json") {
      io.writeStdout(
        `${JSON.stringify(makeCliFailedAgentTaskResult({
          code: "unknown_runtime_failure",
          safeMessage,
          retryable: false,
          ...optionalFailureDetails(errorDetails(error)),
        }))}\n`,
      );
    }
    io.writeStderr(
      `${safeMessage}\n`,
    );
    return 2;
  } finally {
    if (tempStateRoot) {
      await rm(tempStateRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function requestedOutputFormat(
  argv: readonly string[],
): ParsedArgs["format"] {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--format") continue;
    const value = argv[index + 1];
    return value === "result-json" ? "result-json" : "event-ndjson";
  }
  return "event-ndjson";
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let provider: ProviderName | null = null;
  let inputPath: string | undefined;
  let format: ParsedArgs["format"] = "event-ndjson";
  let stateRootDir: string | undefined;
  let providerInstanceId: string | undefined;
  let encryptionKeyEnv = "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY";
  let ephemeral = false;
  let claudeTokenEnv = "CLAUDE_CODE_OAUTH_TOKEN";
  let codexAuthJsonPath: string | undefined;
  let codexAuthJsonEnv = "CODEX_AUTH_JSON_PATH";
  let claudePath: string | undefined;
  let codexBinaryPath: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      const value = requiredValue(argv, index, arg);
      if (
        value !== RuntimeAgentTaskProvider.Claude &&
        value !== RuntimeAgentTaskProvider.Codex
      ) {
        throw new Error("--provider must be claude or codex");
      }
      provider = value === RuntimeAgentTaskProvider.Claude
        ? RuntimeAgentTaskProvider.Claude
        : RuntimeAgentTaskProvider.Codex;
      index += 1;
      continue;
    }
    if (arg === "--input") {
      inputPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--format") {
      const value = requiredValue(argv, index, arg);
      if (value !== "event-ndjson" && value !== "result-json") {
        throw new Error("--format must be event-ndjson or result-json");
      }
      format = value;
      index += 1;
      continue;
    }
    if (arg === "--state-root") {
      stateRootDir = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--provider-instance") {
      providerInstanceId = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--encryption-key-env") {
      encryptionKeyEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ephemeral") {
      ephemeral = true;
      continue;
    }
    if (arg === "--claude-token-env") {
      claudeTokenEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-auth-json") {
      codexAuthJsonPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-auth-json-env") {
      codexAuthJsonEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-path") {
      claudePath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-binary") {
      codexBinaryPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!provider) throw new Error("--provider is required");
  return {
    provider,
    ...(inputPath ? { inputPath } : {}),
    format,
    ...(stateRootDir ? { stateRootDir } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    encryptionKeyEnv,
    ephemeral,
    claudeTokenEnv,
    ...(codexAuthJsonPath ? { codexAuthJsonPath } : {}),
    codexAuthJsonEnv,
    ...(claudePath ? { claudePath } : {}),
    ...(codexBinaryPath ? { codexBinaryPath } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function createDefaultWorker(
  input: RuntimeAgentTaskWorkerFactoryInput,
): RuntimeAgentTaskWorker {
  if (input.provider === RuntimeAgentTaskProvider.Claude) {
    const runtimeModules = claudeRuntimeModuleLoaders(input.claudeRuntimeDistDir);
    return new FileBackendClaudeWorker({
      providerInstanceId: input.providerInstanceId,
      stateRootDir: input.stateRootDir,
      encryptionKey: input.encryptionKey,
      baseEnv: input.env,
      workspacePath: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
      ...(input.claudePath ? { claudePath: input.claudePath } : {}),
      ...runtimeModules,
    });
  }
  return new FileBackendCodexWorker({
    providerInstanceId: input.providerInstanceId,
    stateRootDir: input.stateRootDir,
    encryptionKey: input.encryptionKey,
    codexBinaryPath: input.codexBinaryPath ?? "codex",
    sourceEnv: input.env,
    workspacePath: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
  });
}

function claudeRuntimeModuleLoaders(
  distDir: string | undefined,
): Pick<
  ConstructorParameters<typeof FileBackendClaudeWorker>[0],
  "runtimeModuleLoader" | "providerModuleLoader"
> {
  if (!distDir) return {};
  const resolvedDistDir = resolve(distDir);
  const runtimePath = join(resolvedDistDir, "index.js");
  const providerPath = join(
    resolvedDistDir,
    "infrastructure",
    "claude-bg",
    "provider",
    "index.js",
  );
  if (!existsSync(runtimePath) || !existsSync(providerPath)) {
    throw new Error(
      "CLAUDE_RUNTIME_DIST_DIR must contain index.js and infrastructure/claude-bg/provider/index.js.",
    );
  }
  return {
    runtimeModuleLoader: async () => import(pathToFileURL(runtimePath).href),
    providerModuleLoader: async () => import(pathToFileURL(providerPath).href),
  };
}

async function seedWorker(input: {
  readonly args: ParsedArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly worker: RuntimeAgentTaskWorker;
}): Promise<void> {
  if (input.args.provider === RuntimeAgentTaskProvider.Claude) {
    const token = input.env[input.args.claudeTokenEnv];
    if (token) {
      if (!input.worker.seedClaudeOAuth) {
        throw new Error("selected worker does not support Claude OAuth seeding");
      }
      await input.worker.seedClaudeOAuth({ oauthToken: token });
    }
    return;
  }

  const authJsonPath =
    input.args.codexAuthJsonPath ?? input.env[input.args.codexAuthJsonEnv];
  if (authJsonPath) {
    if (!input.worker.seedCodexAuthJsonFile) {
      throw new Error("selected worker does not support Codex auth seeding");
    }
    await input.worker.seedCodexAuthJsonFile(authJsonPath);
  }
}

async function runWorkerTask(input: {
  readonly request: AgentTaskRequest;
  readonly worker: RuntimeAgentTaskWorker;
  readonly abortSignal: AbortSignal;
}): Promise<AgentTaskResult> {
  const task = agentTaskRequestToProviderTask(input.request);
  try {
    const result = await input.worker.run({
      runId: input.request.runId ?? `agent-task-${randomUUID()}`,
      prompt: task.prompt,
      ...(task.systemPrompt !== undefined ? { systemPrompt: task.systemPrompt } : {}),
      kind: task.kind,
      ...(task.outputSchemaName ? { outputSchemaName: task.outputSchemaName } : {}),
      ...(task.controls ? { controls: task.controls } : {}),
      ...(task.metadata ? { metadata: task.metadata } : {}),
      abortSignal: input.abortSignal,
    });
    return providerTaskResultToAgentTaskResult(toProviderTaskResult(result));
  } catch (error) {
    return makeCliFailedAgentTaskResult({
      code: "unknown_runtime_failure",
      safeMessage:
        error instanceof Error ? error.message : "subscription worker task failed",
      ...optionalFailureDetails(errorDetails(error)),
    });
  }
}

async function runWorkerTaskWithTimeout(input: {
  readonly timeoutMs?: number;
  readonly run: (abortSignal: AbortSignal) => Promise<AgentTaskResult>;
}): Promise<AgentTaskResult> {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const run = input.run(abortController.signal);
    run.catch(() => undefined);

    return input.timeoutMs
      ? await Promise.race([
          run,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              const error = new AgentTaskTimeoutError(input.timeoutMs!);
              reject(error);
              abortController.abort();
            }, input.timeoutMs);
          }),
        ])
      : await run;
  } catch (error) {
    if (!(error instanceof AgentTaskTimeoutError)) throw error;
    return makeFailedAgentTaskResult({
      code: "task_timeout",
      safeMessage: error.message,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class AgentTaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent task timed out after ${timeoutMs}ms.`);
    this.name = "AgentTaskTimeoutError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("subscription worker task aborted");
}

async function disposeWorker(input: {
  readonly worker: RuntimeAgentTaskWorker;
  readonly timeoutMs?: number;
  readonly io: SubscriptionAgentTaskCliIo;
}): Promise<void> {
  if (!input.worker.dispose) return;
  const timeoutMs = Math.min(input.timeoutMs ?? 5_000, 5_000);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const dispose = Promise.resolve().then(() => input.worker.dispose?.());
    dispose.catch(() => undefined);

    await Promise.race([
      dispose,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`subscription_worker_dispose_timeout:${timeoutMs}`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "subscription worker dispose failed";
    input.io.writeStderr(`${message}\n`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function emitResult(input: {
  readonly request: AgentTaskRequest;
  readonly result: AgentTaskResult;
  readonly format: ParsedArgs["format"];
  readonly io: SubscriptionAgentTaskCliIo;
}): Promise<void> {
  if (input.format === "result-json") {
    input.io.writeStdout(`${JSON.stringify(input.result)}\n`);
    return;
  }
  const started: AgentTaskEvent = {
    protocolVersion: agentTaskProtocolVersion,
    type: "started",
    occurredAt: new Date().toISOString(),
  };
  const completed: AgentTaskEvent = {
    protocolVersion: agentTaskProtocolVersion,
    type: "completed",
    occurredAt: new Date().toISOString(),
    result: input.result,
  };
  input.io.writeStdout(`${JSON.stringify(started)}\n`);
  input.io.writeStdout(`${JSON.stringify(completed)}\n`);
}

function toProviderTaskResult(
  result: RuntimeAgentTaskWorkerResult,
): ProviderTaskResult {
  if (result.status === "waiting_for_input") {
    if (!result.runId || !result.request || !result.resumeHandle) {
      throw new Error("agent_task_waiting_result_invalid");
    }
    return {
      status: "waiting_for_input",
      runId: result.runId,
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : { structuredOutput: result.structuredOutput }),
      request: result.request,
      resumeHandle: result.resumeHandle,
      ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      warnings: result.warnings,
    };
  }
  return {
    status: "completed",
    outputText: result.outputText,
    ...(result.structuredOutput === undefined
      ? {}
      : { structuredOutput: result.structuredOutput }),
    ...(result.telemetry ? { telemetry: result.telemetry } : {}),
    warnings: result.warnings,
  };
}

function makeCliFailedAgentTaskResult(input: {
  readonly code: Parameters<typeof makeFailedAgentTaskResult>[0]["code"];
  readonly safeMessage: string;
  readonly retryable?: boolean;
  readonly reconnectRequired?: boolean;
  readonly causeCategory?: string;
  readonly details?: Readonly<Record<string, string>>;
}): AgentTaskResult {
  return {
    protocolVersion: agentTaskProtocolVersion,
    status: "failed",
    failure: {
      code: input.code,
      retryable: input.retryable ?? false,
      reconnectRequired: input.reconnectRequired ?? false,
      safeMessage: input.safeMessage,
      ...(input.causeCategory ? { causeCategory: input.causeCategory } : {}),
      ...(input.details ? { details: input.details } : {}),
    },
    warnings: [],
  };
}

function errorDetails(
  error: unknown,
): Readonly<Record<string, string>> | undefined {
  const details: Record<string, string> = {};
  for (const item of errorChain(error)) {
    mergeStringDetails(details, objectDetails(item));

    if (isSubscriptionWorkerError(item)) {
      details.subscriptionWorkerCode ??= item.code;
      mergeStringDetails(details, item.details);
    }
    if (isObject(item) && typeof item["code"] === "string") {
      details.subscriptionWorkerCode ??= item["code"];
    }

    if (isObject(item)) {
      const exitCode = item["exitCode"];
      if (typeof exitCode === "number" || typeof exitCode === "string") {
        details.exitCode ??= String(exitCode);
      }
      const stderr = item["stderr"];
      if (typeof stderr === "string" && stderr.trim()) {
        details.stderrTail ??= safeDetailTail(stderr);
      }
      const stdout = item["stdout"];
      if (typeof stdout === "string" && stdout.trim()) {
        details.stdoutTail ??= safeDetailTail(stdout);
      }
    }

    const message = item instanceof Error ? item.message : undefined;
    const match = message?.match(
      /(?:codex_json_exec_failed|node_process_runner_failed):(\d+):(.*)$/s,
    );
    if (match) {
      details.exitCode ??= match[1]!;
      if (match[2]?.trim()) {
        details.stderrTail ??= safeDetailTail(match[2]);
      }
    }
  }

  return Object.keys(details).length === 0 ? undefined : details;
}

function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = isObject(current) ? current["cause"] : undefined;
  }
  return chain;
}

function objectDetails(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isObject(value)) return undefined;
  const details = value["details"];
  if (!isObject(details)) return undefined;
  const parsed: Record<string, string> = {};
  mergeStringDetails(parsed, details);
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function mergeStringDetails(
  target: Record<string, string>,
  details: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!details) return;
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== "string") continue;
    if (!value.trim()) continue;
    target[key] ??= safeDetailTail(value);
  }
}

function optionalFailureDetails(
  details: Readonly<Record<string, string>> | undefined,
): { readonly details?: Readonly<Record<string, string>> } {
  return details === undefined || Object.keys(details).length === 0
    ? {}
    : { details };
}

function safeDetailTail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 800 ? normalized : normalized.slice(-800);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    "usage: subscription-runtime-run-agent-task --provider claude|codex [--input request.json]",
    "       [--format event-ndjson|result-json] [--state-root dir | --ephemeral]",
    "       [--provider-instance id] [--model model] [--timeout-ms ms]",
  ].join("\n");
}

const defaultIo: SubscriptionAgentTaskCliIo = {
  async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  writeStdout(chunk: string): void {
    process.stdout.write(chunk);
  },
  writeStderr(chunk: string): void {
    process.stderr.write(chunk);
  },
  cwd(): string {
    return process.cwd();
  },
  env(): Readonly<Record<string, string | undefined>> {
    return process.env;
  },
};

if (await isMainModule()) {
  process.exitCode = await runSubscriptionAgentTaskCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return (await realpath(modulePath)) === (await realpath(process.argv[1]));
  } catch {
    return modulePath === process.argv[1];
  }
}
