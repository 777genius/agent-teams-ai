import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  CheckRunStatus,
  CheckWorkspaceIntegrityDisposition,
  type CheckRun,
  type CheckRunnerPort,
} from "@vioxen/subscription-runtime/worker-core";
import { runCheckWorkspaceTransaction } from "./project-integration-check-workspace-transaction";
import { runIsolatedCheckProcess } from "./project-integration-local-process-group";
import { safeProjectIntegrationOutputTail } from "./project-integration-local-safe-output";

export type LocalProjectCheckRunnerOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitBinaryPath?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly terminationGraceMs?: number;
};

export class LocalProjectCheckRunner implements CheckRunnerPort {
  constructor(private readonly options: LocalProjectCheckRunnerOptions = {}) {}

  async runCheck(input: {
    readonly workspacePath: string;
    readonly allowedWorkspaceFiles: readonly string[];
    readonly check: {
      readonly checkId: string;
      readonly command: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    };
    readonly startedAt: string;
  }): Promise<CheckRun> {
    const completedAt = () => new Date().toISOString();
    if (input.check.command.length === 0) {
      return failedCheck(input, completedAt(), "check_command_required");
    }
    let cwd: string;
    try {
      cwd = await checkCwd(input.workspacePath, input.check.cwd);
    } catch {
      return failedCheck(input, completedAt(), "check_cwd_outside_workspace");
    }
    const [rawCommand, ...rawArgs] = input.check.command;
    const { command, args } = resolveCheckCommand(rawCommand ?? "", rawArgs);
    const transaction = await runCheckWorkspaceTransaction({
      workspacePath: input.workspacePath,
      allowedWorkspaceFiles: input.allowedWorkspaceFiles,
      ...(this.options.gitBinaryPath === undefined
        ? {}
        : { gitBinaryPath: this.options.gitBinaryPath }),
      runCommand: () => runIsolatedCheckProcess({
        command,
        args,
        cwd,
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
        timeoutMs: input.check.timeoutMs ?? this.options.timeoutMs ?? 120_000,
        maxBuffer: this.options.maxBuffer ?? 10 * 1024 * 1024,
        ...(this.options.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: this.options.terminationGraceMs }),
      }),
    });
    if (transaction.status === "hygiene_failed") {
      const result = transaction.commandResult;
      return {
        checkId: input.check.checkId,
        command: input.check.command,
        status: CheckRunStatus.Failed,
        startedAt: input.startedAt,
        completedAt: completedAt(),
        ...(result === undefined ? {} : { exitCode: result.exitCode }),
        safeOutputTail: safeProjectIntegrationOutputTail(
          `${result?.stdout ?? ""}\n${result?.stderr ?? ""}\n${transaction.safeError}`,
        ),
        workspaceIntegrity: transaction.workspaceIntegrity,
      };
    }
    const result = transaction.commandResult;
    return {
      checkId: input.check.checkId,
      command: input.check.command,
      status: result.timedOut
        ? CheckRunStatus.TimedOut
        : result.exitCode === 0
          ? CheckRunStatus.Passed
          : CheckRunStatus.Failed,
      startedAt: input.startedAt,
      completedAt: completedAt(),
      exitCode: result.exitCode,
      safeOutputTail: safeProjectIntegrationOutputTail(
        `${result.stdout}\n${result.stderr}`,
      ),
      workspaceIntegrity: transaction.workspaceIntegrity,
    };
  }
}

function failedCheck(
  input: Parameters<CheckRunnerPort["runCheck"]>[0],
  completedAt: string,
  safeOutputTail: string,
): CheckRun {
  return {
    checkId: input.check.checkId,
    command: input.check.command,
    status: CheckRunStatus.Failed,
    startedAt: input.startedAt,
    completedAt,
    safeOutputTail,
    workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
  };
}

function resolveCheckCommand(
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  if (command === "pnpm" || command === "yarn") {
    return { command: "corepack", args: [command, ...args] };
  }
  return { command, args };
}

async function checkCwd(
  workspacePath: string,
  cwd: string | undefined,
): Promise<string> {
  const workspace = await realpath(workspacePath);
  const candidate =
    cwd === undefined
      ? workspace
      : isAbsolute(cwd)
        ? cwd
        : resolve(workspace, cwd);
  const canonical = await realpath(candidate);
  if (!isPathInside(canonical, workspace)) {
    throw new Error("local_project_check_cwd_outside_workspace");
  }
  return canonical;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
