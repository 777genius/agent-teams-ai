#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ProviderTask,
  ProviderTaskResult,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  FileBackendClaudeWorker,
} from "../worker-claude/file-backend-claude-worker";
import {
  FileBackendCodexWorker,
} from "../worker-codex/file-backend-codex-worker";

type ProviderName = "claude" | "codex";

export type SubscriptionAgentTaskCliIo = {
  readStdin(): Promise<string>;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
};

export type RuntimeAgentTaskWorker = {
  start(): Promise<void>;
  seedClaudeOAuth?(input: { readonly oauthToken: string }): Promise<void>;
  seedCodexAuthJsonFile?(authJsonPath: string): Promise<void>;
  run(job: RuntimeAgentTaskWorkerJob): Promise<RuntimeAgentTaskWorkerResult>;
  dispose?(): Promise<void>;
};

export type RuntimeAgentTaskWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type RuntimeAgentTaskWorkerResult = {
  readonly status?: "completed" | "waiting_for_input";
  readonly runId?: string;
  readonly outputText: string;
  readonly request?: ManagedRunInputRequest;
  readonly resumeHandle?: ManagedRunResumeHandle;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: readonly RuntimeWarning[];
};

export type RuntimeAgentTaskWorkerFactoryInput = {
  readonly provider: ProviderName;
  readonly stateRootDir: string;
  readonly providerInstanceId: string;
  readonly encryptionKey: Uint8Array | string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly claudePath?: string;
  readonly codexBinaryPath?: string;
};

export type RuntimeAgentTaskWorkerFactory = (
  input: RuntimeAgentTaskWorkerFactoryInput,
) => RuntimeAgentTaskWorker;

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
    const workerEnv = args.provider === "claude" ? pruneClaudeChildEnv(env) : env;
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
      ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
    });

    try {
      await worker.start();
      await seedWorker({ args, env, worker });
      const result = await runWorkerTask({ request, worker });
      await emitResult({ request, result, format: args.format, io });
      return result.status === "completed" ? 0 : 1;
    } finally {
      await worker.dispose?.();
    }
  } catch (error) {
    io.writeStderr(
      `${error instanceof Error ? error.message : "subscription runtime agent task failed"}\n`,
    );
    return 2;
  } finally {
    if (tempStateRoot) {
      await rm(tempStateRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function resolveRequestCwd(
  workspaceRoot: string,
  requestedCwd: string,
): Promise<string> {
  const root = await realpath(resolve(workspaceRoot));
  let resolved: string;
  try {
    resolved = await realpath(resolve(root, requestedCwd));
  } catch {
    throw new Error("Agent task cwd must stay within the current workspace.");
  }
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolved;
  }
  throw new Error("Agent task cwd must stay within the current workspace.");
}

export function pruneClaudeChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const allowed = new Set([
    "CI",
    "CLAUDE_CONFIG_DIR",
    "HOME",
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
      if (value !== "claude" && value !== "codex") {
        throw new Error("--provider must be claude or codex");
      }
      provider = value;
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
  if (input.provider === "claude") {
    return new FileBackendClaudeWorker({
      providerInstanceId: input.providerInstanceId,
      stateRootDir: input.stateRootDir,
      encryptionKey: input.encryptionKey,
      baseEnv: input.env,
      workspacePath: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
      ...(input.claudePath ? { claudePath: input.claudePath } : {}),
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

async function seedWorker(input: {
  readonly args: ParsedArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly worker: RuntimeAgentTaskWorker;
}): Promise<void> {
  if (input.args.provider === "claude") {
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
      abortSignal: new AbortController().signal,
    });
    return providerTaskResultToAgentTaskResult(toProviderTaskResult(result));
  } catch (error) {
    return makeFailedAgentTaskResult({
      code: "unknown_runtime_failure",
      safeMessage:
        error instanceof Error ? error.message : "subscription worker task failed",
    });
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
