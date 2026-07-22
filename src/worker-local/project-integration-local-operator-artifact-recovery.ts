import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import {
  OperatorArtifactRecoveryState,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
  type OperatorArtifactRecoveryPermit,
  type OperatorArtifactRecoveryPort,
  type OperatorArtifactRecoveryResult,
  type ValidatedOperatorArtifactRecovery,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertProjectIntegrationPatchSha256,
  canonicalProjectIntegrationPatchPath,
} from "./project-integration-local-adapters";
import {
  assertLocalWorkerPatchBytesExactlyApplied,
  type LocalGitOutputRollbackRuntime,
} from "./project-integration-local-output-rollback";

const execFileAsync = promisify(execFile);

export type LocalOperatorArtifactRecoveryOptions = {
  readonly archiveRoot: string;
  readonly allowedPatchRoots: readonly string[];
  readonly workerJobRootParent?: string;
  readonly controllerArchiveRoot?: string;
  readonly gitBinaryPath?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
};

type RecoveryInput = {
  readonly attempt: IntegrationAttempt;
  readonly permit: OperatorArtifactRecoveryPermit;
  readonly permitSha256: string;
  readonly validation: ValidatedOperatorArtifactRecovery;
};

type RecoveryPaths = {
  readonly root: string;
  readonly artifact: string;
  readonly prepared: string;
  readonly completed: string;
};

type ArtifactState = "source" | "archived";

export class LocalOperatorArtifactRecoveryAdapter implements OperatorArtifactRecoveryPort {
  constructor(private readonly options: LocalOperatorArtifactRecoveryOptions) {}

  async inspect(input: RecoveryInput): Promise<OperatorArtifactRecoveryResult> {
    assertPermitSha256(input.permitSha256);
    const workspacePath = await realpath(input.attempt.targetWorkspacePath);
    const paths = await this.recoveryPaths(input.permitSha256, false);
    const prepared = await readManifest(paths.prepared);
    const completed = await readManifest(paths.completed);
    if (completed !== undefined && prepared === undefined) {
      throw new Error("operator_artifact_recovery_completed_without_prepared");
    }
    if (prepared !== undefined) assertManifest(prepared, input, "prepared");
    if (completed !== undefined) assertManifest(completed, input, "completed");

    await this.assertImmutableCandidatePatch(input);
    const artifactState = await inspectArtifactLocation({
      workspacePath,
      artifactPath: input.validation.artifactPath,
      archivePath: paths.artifact,
      permit: input.permit,
    });
    const expectedDirtyFiles =
      artifactState === "source"
        ? input.validation.expectedDirtyFiles
        : input.validation.appliedFiles;
    await this.assertWorkspaceIdentity({
      workspacePath,
      permit: input.permit,
      expectedDirtyFiles,
      artifactPath: input.validation.artifactPath,
      artifactState,
    });

    return {
      state:
        completed !== undefined
          ? OperatorArtifactRecoveryState.Completed
          : prepared !== undefined
            ? OperatorArtifactRecoveryState.Prepared
            : OperatorArtifactRecoveryState.Ready,
      permitSha256: input.permitSha256,
      artifactArchivePath: paths.artifact,
      ...(prepared === undefined
        ? {}
        : { preparedManifestPath: paths.prepared }),
      ...(completed === undefined
        ? {}
        : { completedManifestPath: paths.completed }),
    };
  }

  async prepare(
    input: RecoveryInput & { readonly preparedAt: string },
  ): Promise<OperatorArtifactRecoveryResult> {
    const inspected = await this.inspect(input);
    if (inspected.state !== OperatorArtifactRecoveryState.Ready)
      return inspected;
    const paths = await this.recoveryPaths(input.permitSha256, true);
    await atomicWriteJson(paths.prepared, {
      ...stableManifest(input),
      stage: "prepared",
      preparedAt: input.preparedAt,
    });
    return await this.inspect(input);
  }

  async complete(
    input: RecoveryInput & { readonly completedAt: string },
  ): Promise<OperatorArtifactRecoveryResult> {
    const inspected = await this.inspect(input);
    if (inspected.state === OperatorArtifactRecoveryState.Completed)
      return inspected;
    if (inspected.state !== OperatorArtifactRecoveryState.Prepared) {
      throw new Error("operator_artifact_recovery_prepare_required");
    }
    const workspacePath = await realpath(input.attempt.targetWorkspacePath);
    const paths = await this.recoveryPaths(input.permitSha256, true);
    const sourcePath = join(workspacePath, input.validation.artifactPath);
    const source = await fileState(sourcePath);
    const archived = await fileState(paths.artifact);
    if (source === "file" && archived === "missing") {
      await quarantineAndValidateOperatorArtifact({
        sourcePath,
        archivePath: paths.artifact,
        permit: input.permit,
      });
    } else if (source !== "missing" || archived !== "file") {
      throw new Error("operator_artifact_recovery_artifact_location_invalid");
    }
    await assertExactArtifact(paths.artifact, input.permit);
    await this.assertWorkspaceIdentity({
      workspacePath,
      permit: input.permit,
      expectedDirtyFiles: input.validation.appliedFiles,
      artifactPath: input.validation.artifactPath,
      artifactState: "archived",
    });
    await atomicWriteJson(paths.completed, {
      ...stableManifest(input),
      stage: "completed",
      completedAt: input.completedAt,
      artifactArchivePath: paths.artifact,
    });
    return await this.inspect(input);
  }

  private async assertImmutableCandidatePatch(
    input: RecoveryInput,
  ): Promise<void> {
    const workerRoot =
      this.options.workerJobRootParent === undefined
        ? []
        : [
            safeWorkerJobRoot(
              this.options.workerJobRootParent,
              input.attempt.workerJobId,
            ),
          ];
    const rawPatchPath = isAbsolute(input.attempt.workerOutput.patchPath!)
      ? input.attempt.workerOutput.patchPath!
      : resolve(
          input.attempt.workerOutput.workspacePath,
          input.attempt.workerOutput.patchPath!,
        );
    const rawPatchStatus = await lstat(rawPatchPath);
    if (!rawPatchStatus.isFile() || rawPatchStatus.isSymbolicLink()) {
      throw new Error("operator_artifact_recovery_candidate_patch_unsafe");
    }
    const patchPath = await canonicalProjectIntegrationPatchPath({
      workspacePath: input.attempt.workerOutput.workspacePath,
      path: input.attempt.workerOutput.patchPath!,
      workerJobId: input.attempt.workerJobId,
      allowedPatchRoots: [...this.options.allowedPatchRoots, ...workerRoot],
      ...(this.options.controllerArchiveRoot === undefined
        ? {}
        : { controllerArchiveRoot: this.options.controllerArchiveRoot }),
    });
    const patchHandle = await open(
      patchPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new Error("operator_artifact_recovery_candidate_patch_unsafe");
    });
    let patchBytes: Buffer;
    try {
      const stat = await patchHandle.stat();
      if (!stat.isFile() || stat.size !== input.permit.candidatePatchSize) {
        throw new Error(
          "operator_artifact_recovery_candidate_patch_bytes_mismatch",
        );
      }
      patchBytes = await patchHandle.readFile();
      if (
        patchBytes.length !== stat.size ||
        createHash("sha256").update(patchBytes).digest("hex") !==
          input.permit.candidatePatchSha256.toLowerCase()
      ) {
        throw new Error(
          "operator_artifact_recovery_candidate_patch_bytes_mismatch",
        );
      }
    } finally {
      await patchHandle.close();
    }
    const workspacePath = await realpath(input.attempt.targetWorkspacePath);
    const indexIdentity = await this.gitOptional(
      ["diff", "--cached", "--quiet", input.permit.targetHeadSha, "--"],
      workspacePath,
    );
    if (indexIdentity.exitCode !== 0) {
      throw new Error("operator_artifact_recovery_index_head_mismatch");
    }
    await assertLocalWorkerPatchBytesExactlyApplied({
      runtime: this.rollbackRuntime(),
      workspacePath,
      appliedFiles: input.validation.appliedFiles,
      expectedCommit: input.permit.targetHeadSha,
      patchBytes,
    });
  }

  private async assertWorkspaceIdentity(input: {
    readonly workspacePath: string;
    readonly permit: OperatorArtifactRecoveryPermit;
    readonly expectedDirtyFiles: readonly string[];
    readonly artifactPath: string;
    readonly artifactState: ArtifactState;
  }): Promise<void> {
    const [head, branch, dirtyFiles, untrackedArtifact, trackedArtifact] =
      await Promise.all([
        this.git(["rev-parse", "HEAD"], input.workspacePath),
        this.git(["rev-parse", "--abbrev-ref", "HEAD"], input.workspacePath),
        this.dirtyFiles(input.workspacePath),
        this.gitOptional(
          [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            input.artifactPath,
          ],
          input.workspacePath,
        ),
        this.gitOptional(
          ["ls-files", "--error-unmatch", "--", input.artifactPath],
          input.workspacePath,
        ),
      ]);
    if (
      head.trim().toLowerCase() !== input.permit.targetHeadSha.toLowerCase()
    ) {
      throw new Error("operator_artifact_recovery_head_mismatch");
    }
    if (branch.trim() !== input.permit.targetBranch) {
      throw new Error("operator_artifact_recovery_branch_mismatch");
    }
    if (!sameFiles(dirtyFiles, input.expectedDirtyFiles)) {
      throw new Error("operator_artifact_recovery_dirty_set_mismatch");
    }
    const untrackedFiles = nullTerminatedPaths(untrackedArtifact.stdout);
    if (
      input.artifactState === "source" &&
      (!sameFiles(untrackedFiles, [input.artifactPath]) ||
        trackedArtifact.exitCode === 0)
    ) {
      throw new Error("operator_artifact_recovery_artifact_not_untracked");
    }
    if (
      input.artifactState === "archived" &&
      (untrackedFiles.length > 0 || trackedArtifact.exitCode === 0)
    ) {
      throw new Error("operator_artifact_recovery_source_artifact_present");
    }
  }

  private async dirtyFiles(workspacePath: string): Promise<readonly string[]> {
    const [working, staged, untracked] = await Promise.all([
      this.git(["diff", "--name-only", "-z"], workspacePath),
      this.git(["diff", "--cached", "--name-only", "-z"], workspacePath),
      this.git(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        workspacePath,
      ),
    ]);
    return uniqueSorted([
      ...nullTerminatedPaths(working),
      ...nullTerminatedPaths(staged),
      ...nullTerminatedPaths(untracked),
    ]);
  }

  private async recoveryPaths(
    permitSha256: string,
    create: boolean,
  ): Promise<RecoveryPaths> {
    const configuredRoot = resolve(this.options.archiveRoot);
    if (create) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await secureDirectoryPath(configuredRoot, create);
    const recoveryParent = join(
      canonicalRoot,
      "integration-check-artifact-recovery",
    );
    if (create) await mkdirIfMissing(recoveryParent);
    const canonicalRecoveryParent = await secureDirectoryPath(
      recoveryParent,
      create,
    );
    const candidateRoot = join(canonicalRecoveryParent, permitSha256);
    if (create) await mkdirIfMissing(candidateRoot);
    const canonicalRecoveryRoot = await secureDirectoryPath(
      candidateRoot,
      create,
    );
    if (!isPathInside(canonicalRecoveryRoot, canonicalRoot)) {
      throw new Error("operator_artifact_recovery_archive_outside_root");
    }
    return {
      root: canonicalRecoveryRoot,
      artifact: join(canonicalRecoveryRoot, "artifact.bin"),
      prepared: join(canonicalRecoveryRoot, "prepared.json"),
      completed: join(canonicalRecoveryRoot, "completed.json"),
    };
  }

  private rollbackRuntime(): LocalGitOutputRollbackRuntime {
    return {
      git: async (args, cwd, env) => {
        const result = await this.gitOptional(args, cwd, env);
        if (result.exitCode !== 0) {
          throw new Error("operator_artifact_recovery_git_failed");
        }
        return result;
      },
      tryGit: (args, cwd, env) => this.gitOptional(args, cwd, env),
      getStatus: async (workspacePath) => ({
        branch: (
          await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)
        ).trim(),
        dirtyFiles: await this.dirtyFiles(workspacePath),
      }),
      canonicalWorkerPatch: async () => {
        throw new Error(
          "operator_artifact_recovery_unreachable_patch_resolver",
        );
      },
      assertPatchSha256: assertProjectIntegrationPatchSha256,
    };
  }

  private async git(args: readonly string[], cwd: string): Promise<string> {
    const result = await this.gitOptional(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error("operator_artifact_recovery_git_failed");
    }
    return result.stdout;
  }

  private async gitOptional(
    args: readonly string[],
    cwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
  }> {
    try {
      const result = await execFileAsync(
        this.options.gitBinaryPath ?? "git",
        [...args],
        {
          cwd,
          env:
            env === undefined
              ? process.env
              : Object.fromEntries(
                  Object.entries(env).filter(
                    (entry): entry is [string, string] =>
                      entry[1] !== undefined,
                  ),
                ),
          timeout: this.options.timeoutMs ?? 30_000,
          maxBuffer: this.options.maxBuffer ?? 10 * 1024 * 1024,
          encoding: "buffer",
        },
      );
      return {
        exitCode: 0,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        timedOut: false,
      };
    } catch (error) {
      const failure = error as {
        readonly code?: number;
        readonly stdout?: Buffer | string;
        readonly stderr?: Buffer | string;
        readonly killed?: boolean;
        readonly signal?: string;
      };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout:
          typeof failure.stdout === "string"
            ? failure.stdout
            : (failure.stdout?.toString("utf8") ?? ""),
        stderr:
          typeof failure.stderr === "string"
            ? failure.stderr
            : (failure.stderr?.toString("utf8") ?? ""),
        timedOut: failure.killed === true || failure.signal === "SIGTERM",
      };
    }
  }
}

export async function quarantineAndValidateOperatorArtifact(input: {
  readonly sourcePath: string;
  readonly archivePath: string;
  readonly permit: OperatorArtifactRecoveryPermit;
}): Promise<void> {
  await rename(input.sourcePath, input.archivePath);
  try {
    await assertExactArtifact(input.archivePath, input.permit);
  } catch (error) {
    await restoreQuarantinedArtifact(input.archivePath, input.sourcePath);
    throw error;
  }
}

function stableManifest(input: RecoveryInput) {
  return {
    schemaVersion: 1,
    permitSha256: input.permitSha256,
    controllerJobId: input.permit.controllerJobId,
    projectId: input.permit.projectId,
    attemptId: input.permit.attemptId,
    attemptStatus: input.permit.expectedAttemptStatus,
    targetWorkspacePath: input.permit.targetWorkspacePath,
    targetBranch: input.permit.targetBranch,
    targetHeadSha: input.permit.targetHeadSha,
    candidatePatchSha256: input.permit.candidatePatchSha256,
    candidatePatchSize: input.permit.candidatePatchSize,
    artifact: input.permit.artifact,
    check: input.permit.check,
    appliedFiles: input.validation.appliedFiles,
  } as const;
}

function assertManifest(
  manifest: unknown,
  input: RecoveryInput,
  stage: "prepared" | "completed",
): void {
  if (!isRecord(manifest))
    throw new Error("operator_artifact_recovery_manifest_invalid");
  const stable = stableManifest(input);
  for (const [key, expected] of Object.entries(stable)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(expected)) {
      throw new Error("operator_artifact_recovery_manifest_mismatch");
    }
  }
  if (manifest.stage !== stage) {
    throw new Error("operator_artifact_recovery_manifest_stage_mismatch");
  }
}

async function inspectArtifactLocation(input: {
  readonly workspacePath: string;
  readonly artifactPath: string;
  readonly archivePath: string;
  readonly permit: OperatorArtifactRecoveryPermit;
}): Promise<ArtifactState> {
  const sourcePath = join(input.workspacePath, input.artifactPath);
  const [source, archived] = await Promise.all([
    fileState(sourcePath),
    fileState(input.archivePath),
  ]);
  if (source === "file" && archived === "missing") {
    await assertExactArtifact(sourcePath, input.permit);
    return "source";
  }
  if (source === "missing" && archived === "file") {
    await assertExactArtifact(input.archivePath, input.permit);
    return "archived";
  }
  throw new Error("operator_artifact_recovery_artifact_location_invalid");
}

async function assertExactArtifact(
  path: string,
  permit: OperatorArtifactRecoveryPermit,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new Error("operator_artifact_recovery_artifact_not_regular_file");
  });
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== permit.artifact.size ||
      (stat.mode & 0o777) !== permit.artifact.mode
    ) {
      throw new Error("operator_artifact_recovery_artifact_metadata_mismatch");
    }
    if (stat.mtimeMs !== permit.artifact.mtimeMs) {
      throw new Error("operator_artifact_recovery_artifact_mtime_mismatch");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) {
      throw new Error("operator_artifact_recovery_artifact_size_changed");
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== permit.artifact.sha256.toLowerCase()) {
      throw new Error("operator_artifact_recovery_artifact_hash_mismatch");
    }
    const startedAt = Date.parse(permit.check.startedAt);
    const completedAt = Date.parse(permit.check.completedAt);
    const toleranceMs = permit.artifact.mtimeToleranceMs ?? 0;
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      stat.mtimeMs < startedAt - toleranceMs ||
      stat.mtimeMs > completedAt + toleranceMs
    ) {
      throw new Error(
        "operator_artifact_recovery_artifact_mtime_outside_check",
      );
    }
  } finally {
    await handle.close();
  }
}

async function restoreQuarantinedArtifact(
  archivePath: string,
  sourcePath: string,
): Promise<void> {
  if ((await fileState(sourcePath)) !== "missing") {
    throw new Error("operator_artifact_recovery_artifact_restore_blocked");
  }
  try {
    await rename(archivePath, sourcePath);
  } catch {
    throw new Error("operator_artifact_recovery_artifact_restore_failed");
  }
}

async function fileState(path: string): Promise<"file" | "missing"> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() ? "file" : failInvalidFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
}

function failInvalidFile(): never {
  throw new Error("operator_artifact_recovery_artifact_not_regular_file");
}

async function readManifest(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new Error("operator_artifact_recovery_manifest_invalid");
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function safeWorkerJobRoot(parent: string, workerJobId: string): string {
  if (
    basename(workerJobId) !== workerJobId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerJobId)
  ) {
    throw new Error("operator_artifact_recovery_worker_job_id_invalid");
  }
  return join(resolve(parent), workerJobId);
}

function nullTerminatedPaths(value: string): readonly string[] {
  return value.split("\0").filter(Boolean).map(normalizeProjectRelativePath);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(normalizeProjectRelativePath))].sort();
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPermitSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("operator_artifact_recovery_permit_hash_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function secureDirectoryPath(
  path: string,
  required: boolean,
): Promise<string> {
  try {
    const status = await lstat(path);
    const effectiveUid = process.geteuid?.();
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      effectiveUid === undefined ||
      status.uid !== effectiveUid ||
      (status.mode & 0o777) !== 0o700
    ) {
      throw new Error("operator_artifact_recovery_archive_directory_unsafe");
    }
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT") && !required) return path;
    throw error;
  }
}

async function mkdirIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
}
