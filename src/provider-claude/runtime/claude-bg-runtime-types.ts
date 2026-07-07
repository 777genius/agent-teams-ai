import type { ClaudeRuntimeEventLike } from "../protocol/claude-runtime-events";

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

export interface FileStatLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface FileSystemLike {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStatLike | null>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

export interface ProcessRunRequestLike {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly stdin?: string | Uint8Array;
}

export interface ProcessRunResultLike {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface ProcessRunnerLike {
  run(request: ProcessRunRequestLike): Promise<ProcessRunResultLike>;
}
