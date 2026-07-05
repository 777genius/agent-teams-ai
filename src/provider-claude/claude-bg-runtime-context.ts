import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { ClaudeRuntimeEventLike } from "./claude-runtime-event-mapper";

export type ClaudeBgRuntimeContextOptions = {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly claudePath?: string;
  readonly commandTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stateFilePath?: string;
  readonly runtimeModuleLoader?: () => Promise<ClaudeRuntimeModule>;
  readonly providerModuleLoader?: () => Promise<ClaudeBgProviderRuntimeModule>;
};

export type ClaudeBgRuntimeContextInput = {
  readonly configDir: string | undefined;
  readonly oauthToken: string;
};

export type ClaudeBgRuntimeContext = {
  readonly runtime: ClaudeRuntimeModule;
  readonly provider: AgentRuntimeProviderLike;
};

export async function createClaudeBgRuntimeContext(
  input: ClaudeBgRuntimeContextInput,
  options: ClaudeBgRuntimeContextOptions = {},
): Promise<ClaudeBgRuntimeContext> {
  if (!input.configDir) {
    throw new Error("claude_config_dir_required");
  }

  const runtime = await (options.runtimeModuleLoader ?? loadClaudeRuntime)();
  const providerRuntime = await (
    options.providerModuleLoader ?? loadClaudeBgProviderRuntime
  )();
  const provider = new providerRuntime.ClaudeBgRuntimeProvider({
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    ...(options.claudePath === undefined ? {} : { claudePath: options.claudePath }),
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    configDir: input.configDir,
    fs: new NodeFileSystem(),
    oauthToken: input.oauthToken,
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    runner: new NodeProcessRunnerLike(),
    store: new runtime.FileRuntimeStateStore({
      filePath:
        options.stateFilePath ??
        join(input.configDir, "subscription-runtime-claude-bg-state.json"),
    }),
  });

  return { runtime, provider };
}

class NodeFileSystem implements FileSystemLike {
  readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return readFile(path, encoding);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async stat(path: string): Promise<FileStatLike | null> {
    try {
      const fileStat = await stat(path);
      return {
        isDirectory: fileStat.isDirectory(),
        isFile: fileStat.isFile(),
        modifiedAtMs: fileStat.mtimeMs,
        size: fileStat.size,
      };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await mkdir(path, options);
  }
}

class NodeProcessRunnerLike implements ProcessRunnerLike {
  run(request: ProcessRunRequestLike): Promise<ProcessRunResultLike> {
    return new Promise<ProcessRunResultLike>((resolve, reject) => {
      const startedAt = performance.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;

      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: toProcessEnv(request.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
      };

      const currentResult = (
        exitCode: number | null,
        signal: NodeJS.Signals | null | undefined,
      ): ProcessRunResultLike => ({
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        exitCode,
        ...(signal === undefined || signal === null ? {} : { signal }),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut,
      });

      child.stdout.on("data", (chunk: Buffer | string | Uint8Array) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string | Uint8Array) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`process_spawn_failed:${error.code ?? "unknown"}`));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(currentResult(exitCode, signal));
      });

      if (request.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, request.timeoutMs);
      }

      child.stdin.end(request.stdin);
    });
  }
}

function loadClaudeRuntime(): Promise<ClaudeRuntimeModule> {
  const specifier = "claude-runtime";
  return import(/* @vite-ignore */ specifier) as Promise<ClaudeRuntimeModule>;
}

function loadClaudeBgProviderRuntime(): Promise<ClaudeBgProviderRuntimeModule> {
  const specifier = "claude-runtime/unstable/claude-bg/provider";
  return import(/* @vite-ignore */ specifier) as Promise<ClaudeBgProviderRuntimeModule>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ClaudeRuntimeModule {
  readonly asCommandId: (value: string) => string;
  readonly asIsoTimestamp: (value: string) => string;
  readonly asThreadId: (value: string) => string;
  readonly FileRuntimeStateStore: new (options: { readonly filePath: string }) => unknown;
}

export interface ClaudeBgProviderRuntimeModule {
  readonly ClaudeBgRuntimeProvider: new (
    options: Record<string, unknown>,
  ) => AgentRuntimeProviderLike;
}

export interface AgentRuntimeProviderLike {
  readonly id: string;
  start(request: {
    readonly command: AgentCommandLike;
    readonly providerId: string;
    readonly requestedAt: string;
    readonly threadId: string;
  }): Promise<AgentRunHandleLike>;
  send?(request: {
    readonly thread: AgentRuntimeThreadLike;
    readonly command: AgentCommandLike;
    readonly previousProviderSessionId?: string;
    readonly requestedAt: string;
  }): Promise<AgentRunHandleLike>;
  observe(
    handle: AgentRunHandleLike,
    options?: {
      readonly abortSignal?: AbortSignal;
      readonly pollIntervalMs?: number;
    },
  ): AsyncIterable<ClaudeRuntimeEventLike>;
  remove(handle: AgentRunHandleLike): Promise<unknown>;
}

export interface AgentRuntimeThreadLike {
  readonly id: string;
  readonly status: "done";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd: string;
  readonly providerId: string;
  readonly latestProviderSessionId?: string;
}

export interface AgentRunHandleLike {
  readonly runId: string;
  readonly providerSessionId?: string;
}

export interface AgentCommandLike {
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly createdAt: string;
  readonly cwd: string;
  readonly id: string;
  readonly maxTurns?: number;
  readonly mcpConfig?: readonly string[];
  readonly mode: "initial" | "followup";
  readonly model: string;
  readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  readonly pluginDirs?: readonly string[];
  readonly prompt: string;
  readonly settings?: string;
  readonly strictMcpConfig?: boolean;
  readonly threadId: string;
}

interface FileStatLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface FileSystemLike {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStatLike | null>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

interface ProcessRunRequestLike {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly stdin?: string | Uint8Array;
}

interface ProcessRunResultLike {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

interface ProcessRunnerLike {
  run(request: ProcessRunRequestLike): Promise<ProcessRunResultLike>;
}

function toProcessEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
