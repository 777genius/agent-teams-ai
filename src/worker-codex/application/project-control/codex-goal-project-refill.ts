import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
  lstat,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ProjectAccessScope,
  ProjectAdmissionWorkerRole,
  ProjectControlBroker,
  ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobManifestSchemaVersion,
  parseCodexGoalJobManifest,
  readCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
} from "../../codex-goal-jobs";
import {
  noopOperationResult,
  type CodexGoalProjectCreateWorktreeInput,
} from "./codex-goal-project-control-contracts";
import {
  execGit,
  execGitStdout,
  stagedPatchSha256,
} from "./codex-goal-project-git";
import { nodeErrorCode } from "./codex-goal-project-utils";
import {
  projectControlRealPathIfExists,
  projectControlRealPathOutsideWorkspaceScope,
} from "./codex-goal-project-workspace-scope";
import {
  prepareProjectPreStartAdmission,
  type PlannedProjectPreStartAdmission,
} from "./codex-goal-project-pre-start-admission";

export async function readTextFileIfExists(
  path: string,
): Promise<string | null> {
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
  const created =
    result.status === "applied" && !input.createWorktreeInput.expectedRealPath;
  try {
    await assertReusableProjectWorktree({
      createWorktreeInput: input.createWorktreeInput,
      scope: input.scope,
    });
  } catch (error) {
    const rollback = created
      ? await removeFailedProjectWorktreeMaterialization(
          input.createWorktreeInput,
        )
      : null;
    if (error instanceof Error && rollback) {
      error.message = `${error.message}; rollback=${rollback}`;
    }
    throw error;
  }
  return { result, created };
}

async function assertReusableProjectWorktree(input: {
  readonly createWorktreeInput: CodexGoalProjectCreateWorktreeInput;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
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
      throw new Error(
        "project_control_existing_worktree_real_path_outside_scope",
      );
    }
    if (
      worktreeInput.expectedRealPath &&
      materializedRealPath !== worktreeInput.expectedRealPath
    ) {
      throw new Error("project_control_existing_worktree_real_path_changed");
    }
    await execGitStdout([
      "-C",
      materializedRealPath,
      "rev-parse",
      "--show-toplevel",
    ]);
    const status = await execGitStdout([
      "-C",
      materializedRealPath,
      "status",
      "--porcelain",
    ]);
    if (
      status.trim().length > 0 &&
      !worktreeInput.inputPatch &&
      worktreeInput.workerRole !== "adoption"
    ) {
      throw new Error("project_control_existing_worktree_dirty");
    }
    if (worktreeInput.inputPatch) {
      await assertReusableInputPatch({
        workspacePath: materializedRealPath,
        patchPath: worktreeInput.inputPatch.path,
        expectedStagedSha256: worktreeInput.inputPatch.stagedSha256,
        expectedChangedPaths: worktreeInput.inputPatch.changedPaths,
      });
    }
    if (worktreeInput.newBranch) {
      const branch = (
        await execGitStdout([
          "-C",
          materializedRealPath,
          "symbolic-ref",
          "--short",
          "HEAD",
        ])
      ).trim();
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

async function assertReusableInputPatch(input: {
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly expectedStagedSha256: string;
  readonly expectedChangedPaths: readonly string[];
}): Promise<void> {
  await execGit([
    "-C",
    input.workspacePath,
    "apply",
    "--cached",
    "--reverse",
    "--check",
    input.patchPath,
  ]);
  if (
    (await stagedPatchSha256(input.workspacePath)) !==
    input.expectedStagedSha256
  ) {
    throw new Error("project_control_existing_worktree_input_patch_mismatch");
  }
  const staged = await execGitStdout([
    "-C",
    input.workspacePath,
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "HEAD",
    "--",
  ]);
  const actual = staged.split("\0").filter(Boolean).sort();
  const expected = [...new Set(input.expectedChangedPaths)].sort();
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new Error("project_control_existing_worktree_input_patch_mismatch");
  }
  const unstaged = await execGitStdout([
    "-C",
    input.workspacePath,
    "diff",
    "--name-only",
    "-z",
    "--",
  ]);
  const untracked = await execGitStdout([
    "-C",
    input.workspacePath,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (unstaged.length > 0 || untracked.length > 0) {
    throw new Error("project_control_existing_worktree_input_patch_dirty");
  }
}

async function resolveProjectWorktreeRevision(
  workspacePath: string,
  ref: string,
): Promise<string> {
  return (
    await execGitStdout([
      "-C",
      workspacePath,
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ])
  ).trim();
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
  readonly workerRole?:
    ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
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
    throw new Error(
      `project_control_existing_job_mismatch:${mismatches.join(",")}`,
    );
  }
  await assertReadablePrompt({
    promptPath: input.expected.promptPath,
    expectedBody: input.promptBody,
  });
}

export function projectRefillJobMismatches(
  existing: CodexGoalJobManifest,
  expected: CodexGoalJobManifestInput,
): readonly string[] {
  const mismatches: string[] = [];
  const normalizedExpected = parseCodexGoalJobManifest({
    ...expected,
    schemaVersion: codexGoalJobManifestSchemaVersion,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  });
  const ignored = new Set(["schemaVersion", "createdAt", "updatedAt"]);
  const fields = new Set([
    ...Object.keys(existing),
    ...Object.keys(normalizedExpected),
  ]);
  for (const field of [...fields].filter((item) => !ignored.has(item)).sort()) {
    const left = existing[field as keyof CodexGoalJobManifest];
    const right = normalizedExpected[field as keyof CodexGoalJobManifest];
    if (stableJson(left ?? null) !== stableJson(right ?? null)) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Replaces only the launch artifacts of an already identity-matched job.
 * The caller owns terminal/liveness/workspace/branch validation and must hold
 * the project workspace lock for the complete transaction.
 */
export async function replaceProjectRefillLaunchArtifacts(input: {
  readonly existing: CodexGoalJobManifest;
  readonly expected: CodexGoalJobManifestInput;
  readonly expectedExistingPromptBody: string;
  readonly promptBody: string;
  readonly admission: PlannedProjectPreStartAdmission;
  readonly scope: ProjectAccessScope;
  readonly verifiedInputPatchArtifactSha256?: string;
  readonly verifiedInputPatchStagedSha256?: string;
  readonly deps?: {
    readonly rename?: typeof rename;
    readonly writeFile?: typeof writeFile;
    readonly prepareAdmission?: typeof prepareProjectPreStartAdmission;
  };
}): Promise<{
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}> {
  const mismatches = projectRefillJobMismatches(input.existing, input.expected);
  if (mismatches.length > 0) {
    throw new Error(
      `project_control_merge_rebind_existing_job_mismatch:${mismatches.join(",")}`,
    );
  }
  await assertReadablePrompt({
    promptPath: input.existing.promptPath,
    expectedBody: input.expectedExistingPromptBody,
  });
  const descriptor = input.existing.projectPreStartAdmission;
  if (!descriptor) {
    throw new Error("project_control_merge_rebind_existing_admission_required");
  }
  const admissionRoot = dirname(descriptor.contractPath);
  if (
    admissionRoot !== dirname(descriptor.statePath) ||
    admissionRoot !== dirname(descriptor.receiptPath) ||
    admissionRoot !== dirname(input.admission.descriptor.contractPath)
  ) {
    throw new Error("project_control_merge_rebind_admission_identity_mismatch");
  }

  const markerPath = join(
    input.existing.jobRootDir,
    ".merge-rebind-transaction.json",
  );
  const admissionBackup = join(
    input.existing.jobRootDir,
    ".pre-start-admission.merge-rebind-backup",
  );
  const promptBackup = `${input.existing.promptPath}.merge-rebind-backup`;
  const markerBase = {
    schemaVersion: 1 as const,
    promptPath: input.existing.promptPath,
    promptBackup,
    admissionRoot,
    admissionBackup,
    original: {
      prompt: await artifactHash(input.existing.promptPath),
      contract: await artifactHash(descriptor.contractPath),
      state: await artifactHash(descriptor.statePath),
      receipt: await artifactHash(descriptor.receiptPath),
    },
    replacement: {
      prompt: sha256Text(input.promptBody),
      contract: sha256Json(input.admission.contract),
      state: sha256Json(input.admission.state),
    },
  };
  await writeMergeRebindMarker(markerPath, {
    ...markerBase,
    state: "replacing",
  });
  let admissionMoved = false;
  let promptMoved = false;
  const renamePath = input.deps?.rename ?? rename;
  const writePrompt = input.deps?.writeFile ?? writeFile;
  const prepareAdmission =
    input.deps?.prepareAdmission ?? prepareProjectPreStartAdmission;
  let settled = false;
  const rollback = async (): Promise<void> => {
    if (settled) return;
    const failures: unknown[] = [];
    if (promptMoved) {
      try {
        await rm(input.existing.promptPath, { force: true });
        await renamePath(promptBackup, input.existing.promptPath);
      } catch (error) {
        failures.push(error);
      }
    }
    if (admissionMoved) {
      try {
        await rm(admissionRoot, { recursive: true, force: true });
        await renamePath(admissionBackup, admissionRoot);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "project_control_merge_rebind_rollback_failed",
      );
    }
    await rm(markerPath, { force: true });
    settled = true;
  };
  try {
    await renamePath(admissionRoot, admissionBackup);
    admissionMoved = true;
    await renamePath(input.existing.promptPath, promptBackup);
    promptMoved = true;
    await writePrompt(input.existing.promptPath, input.promptBody, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await prepareAdmission({
      plan: input.admission,
      manifest: input.expected,
      scope: input.scope,
      ...(input.verifiedInputPatchArtifactSha256
        ? {
            verifiedInputPatchArtifactSha256:
              input.verifiedInputPatchArtifactSha256,
            verifiedInputPatchStagedSha256:
              input.verifiedInputPatchStagedSha256,
          }
        : {}),
    });
    await writeMergeRebindMarker(markerPath, {
      ...markerBase,
      state: "replacing",
      replacement: {
        ...markerBase.replacement,
        receipt: await artifactHash(input.admission.descriptor.receiptPath),
      },
    });
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "project_control_merge_rebind_prepare_and_rollback_failed",
      );
    }
    throw error;
  }
  return {
    rollback,
    commit: async () => {
      if (settled) return;
      await writeMergeRebindMarker(markerPath, {
        ...markerBase,
        state: "committed",
        replacement: {
          ...markerBase.replacement,
          receipt: await artifactHash(input.admission.descriptor.receiptPath),
        },
      });
      settled = true;
      try {
        await rm(promptBackup, { force: true });
        await rm(admissionBackup, { recursive: true, force: true });
        await rm(markerPath, { force: true });
      } catch {
        // The committed marker makes cleanup idempotent on the next refill.
      }
    },
  };
}

type MergeRebindMarker = {
  readonly schemaVersion: 1;
  readonly state: "replacing" | "committed";
  readonly promptPath: string;
  readonly promptBackup: string;
  readonly admissionRoot: string;
  readonly admissionBackup: string;
  readonly original: Readonly<Record<string, string>>;
  readonly replacement: Readonly<Record<string, string>>;
};

export async function projectRefillLaunchArtifactTransactionPending(
  jobRootDir: string,
): Promise<boolean> {
  return pathExists(join(jobRootDir, ".merge-rebind-transaction.json"));
}

export async function reconcileProjectRefillLaunchArtifactTransaction(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
  const jobRootDir = resolve(input.manifest.jobRootDir);
  const registryRoot = input.scope.registryRoot;
  if (!registryRoot) {
    throw new Error("project_control_merge_rebind_registry_root_required");
  }
  const workerJobsRoot = dirname(resolve(registryRoot));
  if (
    jobRootDir !== workerJobsRoot &&
    !jobRootDir.startsWith(`${workerJobsRoot}${sep}`)
  ) {
    throw new Error("project_control_merge_rebind_marker_outside_registry");
  }
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) {
    throw new Error("project_control_merge_rebind_existing_admission_required");
  }
  const markerPath = join(jobRootDir, ".merge-rebind-transaction.json");
  let marker: MergeRebindMarker;
  try {
    marker = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as MergeRebindMarker;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw new Error("project_control_merge_rebind_marker_invalid");
  }
  if (
    marker.schemaVersion !== 1 ||
    (marker.state !== "replacing" && marker.state !== "committed")
  ) {
    throw new Error("project_control_merge_rebind_marker_invalid");
  }
  const expected = {
    promptPath: input.manifest.promptPath,
    promptBackup: `${input.manifest.promptPath}.merge-rebind-backup`,
    admissionRoot: dirname(descriptor.contractPath),
    admissionBackup: join(
      jobRootDir,
      ".pre-start-admission.merge-rebind-backup",
    ),
  };
  for (const [field, path] of Object.entries(expected)) {
    assertPathWithin(jobRootDir, path);
    if (marker[field as keyof typeof expected] !== path) {
      throw new Error("project_control_merge_rebind_marker_path_mismatch");
    }
  }
  if (marker.state === "committed") {
    await assertMarkerArtifactHashes({
      promptPath: expected.promptPath,
      admissionRoot: expected.admissionRoot,
      hashes: marker.replacement,
    });
    await rm(expected.promptBackup, { force: true });
    await rm(expected.admissionBackup, { recursive: true, force: true });
    await rm(markerPath, { force: true });
    return;
  }
  const failures: unknown[] = [];
  if (await pathExists(expected.promptBackup)) {
    try {
      if (
        (await artifactHash(expected.promptBackup)) !== marker.original.prompt
      ) {
        throw new Error("project_control_merge_rebind_marker_hash_mismatch");
      }
      await rm(expected.promptPath, { force: true });
      await rename(expected.promptBackup, expected.promptPath);
    } catch (error) {
      failures.push(error);
    }
  }
  if (await pathExists(expected.admissionBackup)) {
    try {
      await assertMarkerArtifactHashes({
        promptPath: expected.promptBackup,
        admissionRoot: expected.admissionBackup,
        hashes: marker.original,
        skipPrompt: true,
      });
      await rm(expected.admissionRoot, { recursive: true, force: true });
      await rename(expected.admissionBackup, expected.admissionRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "project_control_merge_rebind_reconcile_failed",
    );
  }
  await rm(markerPath, { force: true });
}

function assertPathWithin(root: string, path: string): void {
  const item = relative(root, resolve(path));
  if (item === "" || item === ".." || item.startsWith(`..${sep}`)) {
    throw new Error(
      "project_control_merge_rebind_marker_path_outside_job_root",
    );
  }
}

async function assertMarkerArtifactHashes(input: {
  readonly promptPath: string;
  readonly admissionRoot: string;
  readonly hashes: Readonly<Record<string, string>>;
  readonly skipPrompt?: boolean;
}): Promise<void> {
  const actual = {
    ...(input.skipPrompt
      ? {}
      : { prompt: await artifactHash(input.promptPath) }),
    contract: await artifactHash(join(input.admissionRoot, "contract.json")),
    state: await artifactHash(join(input.admissionRoot, "state.json")),
    receipt: await artifactHash(join(input.admissionRoot, "receipt.json")),
  };
  for (const [field, hash] of Object.entries(actual)) {
    if (input.hashes[field] !== hash) {
      throw new Error("project_control_merge_rebind_marker_hash_mismatch");
    }
  }
}

async function writeMergeRebindMarker(
  path: string,
  marker: MergeRebindMarker,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  await rename(temporaryPath, path);
}

async function artifactHash(path: string): Promise<string> {
  return sha256Text(await readFile(path, "utf8"));
}

function sha256Json(value: unknown): string {
  return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function removeEmptyDir(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) await rmdir(path);
  } catch (error) {
    if (
      nodeErrorCode(error) !== "ENOENT" &&
      nodeErrorCode(error) !== "ENOTDIR"
    ) {
      throw error;
    }
  }
}
