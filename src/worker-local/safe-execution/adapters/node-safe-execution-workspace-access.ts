import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SafeExecutionError,
  type SafeExecutionCommandRunner,
  type SafeExecutionWorkspaceAccess,
} from "@vioxen/subscription-runtime/worker-core";
import { NodeSafeExecutionCommandRunner } from "./node-safe-execution-command-runner";

export type NodeSafeExecutionWorkspaceAccessOptions = {
  readonly commandRunner?: SafeExecutionCommandRunner;
  readonly gitBinaryPath?: string;
  readonly commandTimeoutMs?: number;
};

export class NodeSafeExecutionWorkspaceAccess implements SafeExecutionWorkspaceAccess {
  private readonly commandRunner: SafeExecutionCommandRunner;
  private readonly gitBinaryPath: string;
  private readonly commandTimeoutMs: number;

  constructor(options: NodeSafeExecutionWorkspaceAccessOptions = {}) {
    this.commandRunner =
      options.commandRunner ?? new NodeSafeExecutionCommandRunner();
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  }

  async canonicalizePath(input: { readonly path: string }): Promise<string> {
    const resolved = resolve(input.path);
    return realpath(resolved).catch(() => resolved);
  }

  async assertGitWorkspace(input: {
    readonly workspacePath: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<void> {
    const result = await this.commandRunner
      .run({
        command: this.gitBinaryPath,
        args: ["rev-parse", "--is-inside-work-tree"],
        cwd: input.workspacePath,
        timeoutMs: this.commandTimeoutMs,
        ...(input.abortSignal === undefined
          ? {}
          : { abortSignal: input.abortSignal }),
      })
      .catch(() => null);
    if (result?.stdout.trim() === "true") return;
    throw new SafeExecutionError(
      "safe_execution_workspace_not_git",
      "Safe execution requires a git worktree workspace.",
      { details: { workspacePath: input.workspacePath } },
    );
  }
}
