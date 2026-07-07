import { join } from "node:path";
import type {
  AgentRuntimeProviderLike,
  ClaudeBgProviderRuntimeModule,
  ClaudeRuntimeModule,
} from "./claude-bg-runtime-types";
import {
  NodeFileSystem,
  NodeProcessRunnerLike,
} from "./node-claude-bg-runtime-adapters";

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

export type {
  AgentCommandLike,
  AgentRunHandleLike,
  AgentRuntimeProviderLike,
  AgentRuntimeThreadLike,
  ClaudeBgProviderRuntimeModule,
  ClaudeRuntimeModule,
  FileStatLike,
  FileSystemLike,
  ProcessRunnerLike,
  ProcessRunRequestLike,
  ProcessRunResultLike,
} from "./claude-bg-runtime-types";

function loadClaudeRuntime(): Promise<ClaudeRuntimeModule> {
  const specifier = "claude-runtime";
  return import(/* @vite-ignore */ specifier) as Promise<ClaudeRuntimeModule>;
}

function loadClaudeBgProviderRuntime(): Promise<ClaudeBgProviderRuntimeModule> {
  const specifier = "claude-runtime/unstable/claude-bg/provider";
  return import(/* @vite-ignore */ specifier) as Promise<ClaudeBgProviderRuntimeModule>;
}
