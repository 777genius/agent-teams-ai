import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ProjectAccessScope,
  ProjectAdmissionWorkerRole,
  ProjectControlBroker,
  ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  readCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
} from "../../codex-goal-jobs";
import {
  noopOperationResult,
  type CodexGoalProjectCreateWorktreeInput,
} from "./codex-goal-project-control-contracts";
import { execGit, execGitStdout } from "./codex-goal-project-git";
import { nodeErrorCode } from "./codex-goal-project-utils";
import {
  projectControlRealPathIfExists,
  projectControlRealPathOutsideWorkspaceScope,
} from "./codex-goal-project-workspace-scope";

export async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function assertReadablePrompt(input: {
  readonly promptPath: string;
  readonly expectedBody?: string;
}): Promise<{ readonly promptPath: string; readonly bytes: number }> {
  const body = await readTextFileIfExists(input.promptPath);
  if (body === null || body.trim().length === 0) {
    throw new Error("project_control_prompt_missing_before_start");
  }
  if (input.expectedBody !== undefined && body !== input.expectedBody) {
    throw new Error("project_control_prompt_mismatch");
  }
  return {
    promptPath: input.promptPath,
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

export async function createOrReuseProjectWorktree(input: {
  readonly broker: ProjectControlBroker;
  readonly scope: ProjectAccessScope;
  readonly createWorktreeInput: CodexGoalProjectCreateWorktreeInput;
}): Promise<{
  readonly result: ProjectControlOperationResult;
  readonly created: boolean;
}> {
  const result = await input.broker.createWorktree(input.createWorktreeInput);
  const created = result.status === "applied";
  try {
    await assertReusableProjectWorktree({
      createWorktreeInput: input.createWorktreeInput,
      scope: input.scope,
    });
  } catch (error) {
    const rollback = created
      ? await removeFailedProjectWorktreeMaterialization(input.createWorktreeInput)
      : null;
    if (error instanceof Error && rollback) {
      error.message = `${error.message}; rollback=${rollback}`;
    }
    throw error;
  }
  return { result, created };
}

async function assertReusableProjectWorktree(
  input: {
    readonly createWorktreeInput: CodexGoalProjectCreateWorktreeInput;
    readonly scope: ProjectAccessScope;
  },
): Promise<void> {
  try {
    const worktreeInput = input.createWorktreeInput;
    const materializedRealPath = await projectControlRealPathIfExists(
      worktreeInput.path,
    );
    if (!materializedRealPath) {
      throw new Error("project_control_existing_worktree_invalid");
    }
    const outsideScope = await projectControlRealPathOutsideWorkspaceScope(
      materializedRealPath,
      input.scope,
    );
    if (outsideScope) {
      throw new Error("project_control_existing_worktree_real_path_outside_scope");
    }
    if (
      worktreeInput.expectedRealPath &&
      materializedRealPath !== worktreeInput.expectedRealPath
    ) {
      throw new Error("project_control_existing_worktree_real_path_changed");
    }
    await execGitStdout(["-C", materializedRealPath, "rev-parse", "--show-toplevel"]);
    const status = await execGitStdout([
      "-C",
      materializedRealPath,
      "status",
      "--porcelain",
    ]);
    if (status.trim().length > 0) {
      throw new Error("project_control_existing_worktree_dirty");
    }
    if (worktreeInput.newBranch) {
      const branch = (await execGitStdout([
        "-C",
        materializedRealPath,
        "symbolic-ref",
        "--short",
        "HEAD",
      ])).trim();
      if (branch !== worktreeInput.newBranch) {
        throw new Error("project_control_existing_worktree_branch_mismatch");
      }
    }
    const actual = await resolveProjectWorktreeRevision(
      materializedRealPath,
      "HEAD",
    );
    if (actual !== worktreeInput.expectedRevision) {
      throw new Error("project_control_existing_worktree_revision_mismatch");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("project_control_existing_worktree_")
    ) {
      throw error;
    }
    throw new Error("project_control_existing_worktree_invalid");
  }
}

async function resolveProjectWorktreeRevision(
  workspacePath: string,
  ref: string,
): Promise<string> {
  return (await execGitStdout([
    "-C",
    workspacePath,
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ])).trim();
}

async function removeFailedProjectWorktreeMaterialization(
  input: CodexGoalProjectCreateWorktreeInput,
): Promise<string | null> {
  try {
    await execGit([
      "-C",
      input.expectedSourceRealPath,
      "worktree",
      "remove",
      input.path,
    ]);
    return "worktree";
  } catch {
    return "worktree-remove-failed";
  }
}

export async function rollbackProjectRefillPartial(input: {
  readonly expectedSourceRealPath: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly worktreeCreated: boolean;
  readonly promptWritten: boolean;
}): Promise<readonly string[]> {
  const rolledBack: string[] = [];
  if (input.promptWritten) {
    await rm(input.promptPath, { force: true });
    rolledBack.push("prompt");
  }
  await removeEmptyDir(dirname(input.promptPath));
  await removeEmptyDir(join(input.registryRootDir, input.jobId));
  if (input.worktreeCreated) {
    try {
      await execGit([
        "-C",
        input.expectedSourceRealPath,
        "worktree",
        "remove",
        "--force",
        input.workspacePath,
      ]);
      rolledBack.push("worktree");
    } catch {
      rolledBack.push("worktree-remove-failed");
    }
  }
  return rolledBack;
}

export async function createOrReuseProjectJob(input: {
  readonly broker: ProjectControlBroker;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifestInput;
  readonly promptBody: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
}): Promise<{
  readonly result: ProjectControlOperationResult;
  readonly manifest: CodexGoalJobManifest;
}> {
  const existing = await readExistingCodexGoalJob({
    registryRootDir: input.registryRootDir,
    jobId: input.manifest.jobId,
  });
  if (existing) {
    await assertExistingRefillJobMatches({
      existing,
      expected: input.manifest,
      promptBody: input.promptBody,
    });
    return {
      result: noopOperationResult(
        existing.jobId,
        "existing job manifest and prompt reused for idempotent refill",
      ),
      manifest: existing,
    };
  }
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    input.manifest.workspacePath,
    input.scope,
  );
  const result = await input.broker.createJob({
    jobId: input.manifest.jobId,
    registryRoot: input.registryRootDir,
    workspacePath: input.manifest.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(input.manifest.tmuxSession
      ? { tmuxSession: input.manifest.tmuxSession }
      : {}),
    accounts: input.manifest.accounts,
    ...(input.workerRole ? { workerRole: input.workerRole } : {}),
    ...(input.manifest.tags ? { tags: input.manifest.tags } : {}),
  });
  return {
    result,
    manifest: await readCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: input.manifest.jobId,
    }),
  };
}

async function readExistingCodexGoalJob(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
}): Promise<CodexGoalJobManifest | null> {
  try {
    return await readCodexGoalJob(input);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function assertExistingRefillJobMatches(input: {
  readonly existing: CodexGoalJobManifest;
  readonly expected: CodexGoalJobManifestInput;
  readonly promptBody: string;
}): Promise<void> {
  const mismatches = projectRefillJobMismatches(input.existing, input.expected);
  if (mismatches.length > 0) {
    throw new Error(`project_control_existing_job_mismatch:${mismatches.join(",")}`);
  }
  await assertReadablePrompt({
    promptPath: input.expected.promptPath,
    expectedBody: input.promptBody,
  });
}

function projectRefillJobMismatches(
  existing: CodexGoalJobManifest,
  expected: CodexGoalJobManifestInput,
): readonly string[] {
  const mismatches: string[] = [];
  const checks: Array<readonly [string, unknown, unknown]> = [
    ["jobRootDir", existing.jobRootDir, expected.jobRootDir],
    ["workspacePath", existing.workspacePath, expected.workspacePath],
    ["promptPath", existing.promptPath, expected.promptPath],
    ["taskId", existing.taskId, expected.taskId],
    ["tmuxSession", existing.tmuxSession, expected.tmuxSession],
    ["accessBoundary", existing.accessBoundary, expected.accessBoundary],
    ["networkAccess", existing.networkAccess, expected.networkAccess],
    [
      "allowDangerFullAccess",
      existing.allowDangerFullAccess,
      expected.allowDangerFullAccess,
    ],
    [
      "projectPreStartAdmission",
      existing.projectPreStartAdmission,
      expected.projectPreStartAdmission,
    ],
    ["accounts", existing.accounts, expected.accounts],
    ["projectAccessScope", existing.projectAccessScope, expected.projectAccessScope],
  ];
  for (const [field, left, right] of checks) {
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

async function removeEmptyDir(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) await rmdir(path);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT" && nodeErrorCode(error) !== "ENOTDIR") {
      throw error;
    }
  }
}
