import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  emptyReviewedPatchSha256,
  OpaqueSecretDetectionPolicy,
  ReviewDecisionStatus,
  type ReviewDecision,
  type WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalWorkspaceIntegrationLock,
} from "@vioxen/subscription-runtime/worker-local";
import { readLocalGitHeadCommit } from "../../codex-goal-git-revision";
import {
  captureGitWorkspaceChangedFiles,
  captureGitWorkspacePatch,
} from "../../codex-goal-runtime-result-io";
import {
  inspectNodeDependencyEnvironment,
  sanitizeNodeDependencyEnvironment,
} from "../../dependency-environment-safety";
import { assertGitPatchBlobsSecretSafe } from "../../git-patch-secret-validator";
import {
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputFormat,
  type ReviewedWorkerOutputReviewAttestation,
  type ReviewedWorkerOutputSnapshot,
  type ReviewedWorkerOutputWorkspaceSnapshot,
} from "../domain/reviewed-worker-output";
import type {
  ReviewedWorkerContinuationEnvironmentPort,
  ReviewedWorkerOutputReviewMarkerVerifierPort,
  ReviewedWorkerOutputSnapshotterPort,
  ReviewedWorkerOutputStorePort,
} from "../ports/reviewed-worker-output-ports";

const maxReviewedChangedFiles = 256;
const maxReviewedInputFiles = 1024;
const maxReviewedManifestBytes = 1024 * 1024;
const maxReviewedPatchBytes = 16 * 1024 * 1024;

export class GitReviewedWorkerOutputSnapshotter implements ReviewedWorkerOutputSnapshotterPort {
  constructor(
    private readonly options: {
      readonly tempRootDir: string;
      readonly gitBinaryPath?: string;
    },
  ) {}

  async capture(input: {
    readonly workspacePath: string;
    readonly allowEmptyPatch?: boolean;
  }): Promise<ReviewedWorkerOutputWorkspaceSnapshot> {
    const baseCommit = await readLocalGitHeadCommit(input.workspacePath);
    if (!baseCommit)
      throw new Error("reviewed_worker_output_base_commit_required");
    const patch = await captureGitWorkspacePatch({
      workspacePath: input.workspacePath,
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    const changedFiles = await captureGitWorkspaceChangedFiles({
      workspacePath: input.workspacePath,
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    if (!patch.trim()) {
      if (
        input.allowEmptyPatch !== true ||
        patch.length !== 0 ||
        changedFiles.length !== 0
      ) {
        throw new Error("reviewed_worker_output_patch_required");
      }
      return { patch, baseCommit, changedFiles: [] };
    }
    if (changedFiles.length === 0) {
      throw new Error("reviewed_worker_output_changed_files_required");
    }
    await this.assertPatchAppliesToBase({
      workspacePath: input.workspacePath,
      baseCommit,
      patch,
      changedFiles,
    });
    return {
      patch,
      baseCommit,
      changedFiles,
    };
  }

  private async assertPatchAppliesToBase(input: {
    readonly workspacePath: string;
    readonly baseCommit: string;
    readonly patch: string;
    readonly changedFiles: readonly string[];
  }): Promise<void> {
    await mkdir(this.options.tempRootDir, { recursive: true, mode: 0o700 });
    const tempDir = await mkdtemp(join(this.options.tempRootDir, ".capture-"));
    const patchPath = join(tempDir, "output.patch");
    try {
      await writeFile(patchPath, input.patch, {
        encoding: "utf8",
        mode: 0o600,
      });
      await assertGitPatchBlobsSecretSafe({
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        patchPath,
        changedPaths: input.changedFiles,
        tempRootDir: tempDir,
        opaqueContentPolicy:
          OpaqueSecretDetectionPolicy.ScanKnownSignatures,
        ...(this.options.gitBinaryPath === undefined
          ? {}
          : { gitBinaryPath: this.options.gitBinaryPath }),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("git_patch_secret_like_content:")
      ) {
        throw new Error("reviewed_worker_output_secret_like_content");
      }
      if (
        error instanceof Error &&
        error.message === "git_patch_secret_changed_path_limit_exceeded"
      ) {
        throw new Error("reviewed_worker_output_changed_file_limit_exceeded");
      }
      throw new Error("reviewed_worker_output_patch_apply_check_failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class LocalReviewedWorkerOutputStore implements ReviewedWorkerOutputStorePort {
  constructor(private readonly options: { readonly rootDir: string }) {}

  async create(input: {
    readonly snapshot: Omit<ReviewedWorkerOutputSnapshot, "patchPath">;
    readonly patch: string;
  }): Promise<ReviewedWorkerOutputSnapshot> {
    assertSha256(input.snapshot.reviewedOutputId);
    assertReviewedPatchInvariant(input.snapshot, input.patch);
    assertReviewedFileList(input.snapshot.changedFiles, {
      allowEmpty: input.snapshot.merge !== undefined,
    });
    assertReviewedFileList(input.snapshot.reviewDecision.approvedFiles, {
      allowEmpty: isTopologyOnlyReviewedSnapshot(input.snapshot),
    });
    const patchSha256 = sha256(input.patch);
    if (patchSha256 !== input.snapshot.patchSha256) {
      throw new Error("reviewed_worker_output_store_patch_hash_mismatch");
    }
    if (Buffer.byteLength(input.patch) !== input.snapshot.patchByteLength) {
      throw new Error("reviewed_worker_output_store_patch_size_mismatch");
    }
    if (input.snapshot.patchByteLength > maxReviewedPatchBytes) {
      throw new Error("reviewed_worker_output_store_patch_size_mismatch");
    }
    const itemDir = this.itemDir(input.snapshot.reviewedOutputId);
    const patchPath = join(itemDir, "output.patch");
    const snapshot: ReviewedWorkerOutputSnapshot = {
      ...input.snapshot,
      patchPath,
    };
    const existing = await this.readSnapshot(input.snapshot.reviewedOutputId);
    if (existing) {
      if (!sameReviewedOutput(existing, snapshot)) {
        throw new Error("reviewed_worker_output_immutable_conflict");
      }
      return existing;
    }

    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    const tempDir = join(
      this.options.rootDir,
      `.create-${input.snapshot.reviewedOutputId}-${randomUUID()}`,
    );
    await mkdir(tempDir, { mode: 0o700 });
    try {
      await writeFile(join(tempDir, "output.patch"), input.patch, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeFile(
        join(tempDir, "manifest.json"),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      try {
        await rename(tempDir, itemDir);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    const stored = await this.readSnapshot(input.snapshot.reviewedOutputId);
    if (!stored) throw new Error("reviewed_worker_output_store_create_failed");
    if (!sameReviewedOutput(stored, snapshot)) {
      throw new Error("reviewed_worker_output_immutable_conflict");
    }
    return stored;
  }

  async commitReviewAttestation(input: {
    readonly attestation: ReviewedWorkerOutputReviewAttestation;
    readonly reviewMarkerContent: string;
  }): Promise<void> {
    assertSha256(input.attestation.reviewedOutputId);
    assertSha256(input.attestation.reviewMarkerSha256);
    if (
      sha256(input.reviewMarkerContent) !== input.attestation.reviewMarkerSha256
    ) {
      throw new Error("reviewed_worker_output_review_marker_hash_mismatch");
    }
    const snapshot = await this.readSnapshot(
      input.attestation.reviewedOutputId,
    );
    if (!snapshot) throw new Error("reviewed_worker_output_not_found");
    const itemDir = this.itemDir(input.attestation.reviewedOutputId);
    const attestationPath = join(itemDir, "review-attestation.json");
    const existing = await this.readReviewAttestation(attestationPath);
    if (existing) {
      if (existing.reviewedOutputId !== input.attestation.reviewedOutputId) {
        throw new Error("reviewed_worker_output_review_attestation_conflict");
      }
      const markerCopy = await readFile(
        this.reviewMarkerCopyPath(itemDir, existing.reviewMarkerSha256),
        "utf8",
      );
      if (sha256(markerCopy) !== existing.reviewMarkerSha256) {
        throw new Error(
          "reviewed_worker_output_review_attestation_marker_hash_mismatch",
        );
      }
      return;
    }
    const markerCopyPath = this.reviewMarkerCopyPath(
      itemDir,
      input.attestation.reviewMarkerSha256,
    );
    await this.writeImmutableFile(markerCopyPath, input.reviewMarkerContent);
    const tempPath = join(itemDir, `.review-attestation-${randomUUID()}.tmp`);
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(input.attestation, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      try {
        await link(tempPath, attestationPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    } finally {
      await rm(tempPath, { force: true });
    }
    const committed = await this.readReviewAttestation(attestationPath);
    if (
      !committed ||
      committed.reviewedOutputId !== input.attestation.reviewedOutputId
    ) {
      throw new Error(
        "reviewed_worker_output_review_attestation_commit_failed",
      );
    }
  }

  async get(
    reviewedOutputId: string,
  ): Promise<ReviewedWorkerOutputSnapshot | undefined> {
    const snapshot = await this.readSnapshot(reviewedOutputId);
    if (!snapshot) return undefined;
    const attestation =
      (await this.readReviewAttestation(
        join(this.itemDir(reviewedOutputId), "review-attestation.json"),
      )) ??
      (await this.readLegacyApprovedAttestation(
        join(this.itemDir(reviewedOutputId), "approval.json"),
        snapshot,
      ));
    if (!attestation) return undefined;
    if (attestation.reviewedOutputId !== reviewedOutputId) {
      throw new Error("reviewed_worker_output_review_attestation_id_mismatch");
    }
    const markerCopy = await readFile(
      this.reviewMarkerCopyPath(
        this.itemDir(reviewedOutputId),
        attestation.reviewMarkerSha256,
      ),
      "utf8",
    );
    if (sha256(markerCopy) !== attestation.reviewMarkerSha256) {
      throw new Error(
        "reviewed_worker_output_review_attestation_marker_hash_mismatch",
      );
    }
    return snapshot;
  }

  async readPatch(snapshot: ReviewedWorkerOutputSnapshot): Promise<string> {
    const itemDir = this.itemDir(snapshot.reviewedOutputId);
    const expectedPatchPath = join(itemDir, "output.patch");
    if (snapshot.patchPath !== expectedPatchPath) {
      throw new Error("reviewed_worker_output_patch_path_mismatch");
    }
    const item = await lstat(expectedPatchPath);
    if (
      item.isSymbolicLink() ||
      !item.isFile() ||
      item.size > maxReviewedPatchBytes
    ) {
      throw new Error("reviewed_worker_output_artifact_unsafe");
    }
    const patch = await readFile(expectedPatchPath, "utf8");
    if (
      Buffer.byteLength(patch) !== snapshot.patchByteLength ||
      sha256(patch) !== snapshot.patchSha256
    ) {
      throw new Error("reviewed_worker_output_manifest_patch_hash_mismatch");
    }
    return patch;
  }

  private async readSnapshot(
    reviewedOutputId: string,
  ): Promise<ReviewedWorkerOutputSnapshot | undefined> {
    assertSha256(reviewedOutputId);
    const itemDir = this.itemDir(reviewedOutputId);
    const manifestPath = join(itemDir, "manifest.json");
    const patchPath = join(itemDir, "output.patch");
    try {
      await access(manifestPath);
      const [manifestItem, patchItem] = await Promise.all([
        lstat(manifestPath),
        lstat(patchPath),
      ]);
      if (
        manifestItem.isSymbolicLink() ||
        !manifestItem.isFile() ||
        manifestItem.size > maxReviewedManifestBytes ||
        patchItem.isSymbolicLink() ||
        !patchItem.isFile() ||
        patchItem.size > maxReviewedPatchBytes
      ) {
        throw new Error("reviewed_worker_output_artifact_unsafe");
      }
      const [rawManifest, patch] = await Promise.all([
        readFile(manifestPath, "utf8"),
        readFile(patchPath, "utf8"),
      ]);
      if (
        Buffer.byteLength(rawManifest) > maxReviewedManifestBytes ||
        Buffer.byteLength(patch) > maxReviewedPatchBytes
      ) {
        throw new Error("reviewed_worker_output_artifact_unsafe");
      }
      const snapshot = parseSnapshot(rawManifest, patchPath);
      if (snapshot.reviewedOutputId !== reviewedOutputId) {
        throw new Error("reviewed_worker_output_manifest_id_mismatch");
      }
      if (
        sha256(
          reviewedWorkerOutputIdentityPayload({
            format: snapshot.format,
            formatRevision: snapshot.formatRevision,
            projectId: snapshot.projectId,
            controllerJobId: snapshot.controllerJobId,
            workerJobId: snapshot.workerJobId,
            taskId: snapshot.taskId,
            sourceWorkspacePath: snapshot.sourceWorkspacePath,
            baseCommit: snapshot.baseCommit,
            patchSha256: snapshot.patchSha256,
            changedFiles: snapshot.changedFiles,
            reviewDecision: snapshot.reviewDecision,
            ...(snapshot.merge ? { merge: snapshot.merge } : {}),
          }),
        ) !== reviewedOutputId
      ) {
        throw new Error("reviewed_worker_output_manifest_identity_mismatch");
      }
      if (sha256(patch) !== snapshot.patchSha256) {
        throw new Error("reviewed_worker_output_manifest_patch_hash_mismatch");
      }
      if (Buffer.byteLength(patch) !== snapshot.patchByteLength) {
        throw new Error("reviewed_worker_output_manifest_patch_size_mismatch");
      }
      return snapshot;
    } catch (error) {
      if (isMissingError(error)) return undefined;
      throw error;
    }
  }

  private async readReviewAttestation(
    attestationPath: string,
  ): Promise<ReviewedWorkerOutputReviewAttestation | undefined> {
    try {
      const value = JSON.parse(
        await readFile(attestationPath, "utf8"),
      ) as unknown;
      return parseReviewAttestation(value);
    } catch (error) {
      if (isMissingError(error)) return undefined;
      throw error;
    }
  }

  private async readLegacyApprovedAttestation(
    approvalPath: string,
    snapshot: ReviewedWorkerOutputSnapshot,
  ): Promise<ReviewedWorkerOutputReviewAttestation | undefined> {
    try {
      const value = JSON.parse(await readFile(approvalPath, "utf8")) as unknown;
      const legacy = parseLegacyApproval(value);
      if (snapshot.reviewDecision.decision !== ReviewDecisionStatus.Approved) {
        throw new Error(
          "reviewed_worker_output_legacy_approval_requires_approved_decision",
        );
      }
      return {
        format: "reviewed-worker-output-review-attestation",
        formatRevision: 1,
        reviewedOutputId: legacy.reviewedOutputId,
        reviewMarkerPath: legacy.reviewMarkerPath,
        reviewMarkerSha256: legacy.reviewMarkerSha256,
        committedAt: legacy.committedAt,
      };
    } catch (error) {
      if (isMissingError(error)) return undefined;
      throw error;
    }
  }

  private itemDir(reviewedOutputId: string): string {
    return join(this.options.rootDir, reviewedOutputId);
  }

  private reviewMarkerCopyPath(itemDir: string, markerSha256: string): string {
    assertSha256(markerSha256);
    return join(itemDir, `review-marker-${markerSha256}.json`);
  }

  private async writeImmutableFile(
    path: string,
    content: string,
  ): Promise<void> {
    try {
      const existing = await readFile(path, "utf8");
      if (existing !== content) {
        throw new Error("reviewed_worker_output_immutable_conflict");
      }
      return;
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(tempPath, path);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    } finally {
      await rm(tempPath, { force: true });
    }
    if ((await readFile(path, "utf8")) !== content) {
      throw new Error("reviewed_worker_output_immutable_conflict");
    }
  }
}

export class LocalReviewedWorkerOutputReviewMarkerVerifier implements ReviewedWorkerOutputReviewMarkerVerifierPort {
  async verify(input: {
    readonly markerPath: string;
    readonly snapshot: ReviewedWorkerOutputSnapshot;
  }): Promise<{
    readonly markerSha256: string;
    readonly markerContent: string;
  }> {
    const raw = await readFile(input.markerPath, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !isRecord(value.reviewedOutput)) {
      throw new Error("reviewed_worker_output_review_marker_invalid");
    }
    assertExactKeys(value.reviewedOutput, [
      "reviewedOutputId",
      "patchSha256",
      "patchPath",
      "baseCommit",
      "changedFiles",
      "reviewedBy",
      "decision",
      "merge",
      "capturedAt",
    ]);
    if (
      value.reviewedOutput.reviewedOutputId !==
        input.snapshot.reviewedOutputId ||
      value.reviewedOutput.patchSha256 !== input.snapshot.patchSha256 ||
      value.reviewedOutput.patchPath !== input.snapshot.patchPath ||
      value.reviewedOutput.baseCommit !== input.snapshot.baseCommit ||
      stableJson(value.reviewedOutput.changedFiles) !==
        stableJson(input.snapshot.changedFiles) ||
      value.reviewedOutput.reviewedBy !==
        input.snapshot.reviewDecision.reviewedBy ||
      value.reviewedOutput.decision !==
        input.snapshot.reviewDecision.decision ||
      stableJson(value.reviewedOutput.merge) !==
        stableJson(input.snapshot.merge) ||
      value.reviewedOutput.capturedAt !== input.snapshot.capturedAt
    ) {
      throw new Error("reviewed_worker_output_review_marker_mismatch");
    }
    return { markerSha256: sha256(raw), markerContent: raw };
  }
}

export class LocalReviewedWorkerContinuationEnvironment implements ReviewedWorkerContinuationEnvironmentPort {
  async sanitizeDependencyRootLinks(input: {
    readonly workspacePath: string;
  }): Promise<{ readonly removedPaths: readonly string[] }> {
    return sanitizeNodeDependencyEnvironment(input);
  }

  async assertDependencyRootsSafe(input: {
    readonly workspacePath: string;
  }): Promise<void> {
    const inspection = await inspectNodeDependencyEnvironment(input);
    if (inspection.unsafeDependencyRoots.length > 0) {
      throw new Error(
        "reviewed_worker_output_dependency_tree_outside_workspace",
      );
    }
  }
}

export function localReviewedWorkerOutputDeps(input: {
  readonly rootDir: string;
  readonly locks?: WorkspaceLockPort;
}) {
  return {
    snapshotter: new GitReviewedWorkerOutputSnapshotter({
      tempRootDir: join(input.rootDir, ".captures"),
    }),
    store: new LocalReviewedWorkerOutputStore({ rootDir: input.rootDir }),
    markerVerifier: new LocalReviewedWorkerOutputReviewMarkerVerifier(),
    continuationEnvironment: new LocalReviewedWorkerContinuationEnvironment(),
    locks:
      input.locks ??
      new LocalWorkspaceIntegrationLock({
        rootDir: join(input.rootDir, ".locks"),
        staleLockMs: 30 * 60_000,
      }),
  };
}

export function reviewedWorkerOutputRoot(registryRootDir: string): string {
  return join(dirname(registryRootDir), "reviewed-worker-outputs");
}

function parseSnapshot(
  raw: string,
  patchPath: string,
): ReviewedWorkerOutputSnapshot {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value))
    throw new Error("reviewed_worker_output_manifest_invalid");
  assertExactKeys(value, [
    "format",
    "formatRevision",
    "reviewedOutputId",
    "projectId",
    "controllerJobId",
    "workerJobId",
    "taskId",
    "sourceWorkspacePath",
    "patchPath",
    "patchSha256",
    "patchByteLength",
    "baseCommit",
    "changedFiles",
    "reviewDecision",
    "merge",
    "capturedAt",
  ]);
  const merge = value.merge === undefined
    ? undefined
    : parseMergePlan(value.merge);
  const changedFiles = requiredReviewedFileList(value.changedFiles, {
    allowEmpty: merge !== undefined,
  });
  const reviewDecision = parseReviewDecision(value.reviewDecision, {
    allowEmptyApprovedFiles: merge !== undefined && changedFiles.length === 0,
  });
  const patchByteLength = requiredNonNegativeInteger(value.patchByteLength);
  const snapshot: ReviewedWorkerOutputSnapshot = {
    format: reviewedWorkerOutputFormat,
    formatRevision: 1,
    reviewedOutputId: requiredString(value.reviewedOutputId),
    projectId: requiredString(value.projectId),
    controllerJobId: requiredString(value.controllerJobId),
    workerJobId: requiredString(value.workerJobId),
    taskId: requiredString(value.taskId),
    sourceWorkspacePath: requiredString(value.sourceWorkspacePath),
    patchPath,
    patchSha256: requiredString(value.patchSha256),
    patchByteLength,
    baseCommit: requiredString(value.baseCommit),
    changedFiles,
    reviewDecision,
    ...(merge ? { merge } : {}),
    capturedAt: requiredString(value.capturedAt),
  };
  if (
    value.format !== reviewedWorkerOutputFormat ||
    value.formatRevision !== 1 ||
    value.patchPath !== patchPath
  ) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  assertSha256(snapshot.reviewedOutputId);
  assertSha256(snapshot.patchSha256);
  assertReviewedPatchInvariant(snapshot);
  return snapshot;
}

function parseMergePlan(value: unknown): NonNullable<ReviewedWorkerOutputSnapshot["merge"]> {
  if (!isRecord(value)) {
    throw new Error("reviewed_worker_output_merge_invalid");
  }
  assertExactKeys(value, [
    "sourceRemote",
    "sourceBranch",
    "sourceCommit",
    "expectedTargetCommit",
  ]);
  const merge = {
    sourceRemote: requiredString(value.sourceRemote),
    sourceBranch: requiredString(value.sourceBranch),
    sourceCommit: requiredString(value.sourceCommit).toLowerCase(),
    expectedTargetCommit: requiredString(value.expectedTargetCommit).toLowerCase(),
  };
  if (
    !/^[A-Za-z0-9._-]+$/.test(merge.sourceRemote) ||
    !merge.sourceBranch ||
    merge.sourceBranch.startsWith("-") ||
    !/^[a-f0-9]{40}$/.test(merge.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(merge.expectedTargetCommit) ||
    merge.sourceCommit === merge.expectedTargetCommit
  ) {
    throw new Error("reviewed_worker_output_merge_invalid");
  }
  return merge;
}

function parseReviewDecision(
  value: unknown,
  options: { readonly allowEmptyApprovedFiles?: boolean } = {},
): ReviewDecision {
  if (!isRecord(value) || !isReviewDecisionStatus(value.decision)) {
    throw new Error("reviewed_worker_output_review_invalid");
  }
  assertExactKeys(value, [
    "reviewedBy",
    "decision",
    "reason",
    "approvedFiles",
    "requiredChecks",
  ]);
  return {
    reviewedBy: requiredString(value.reviewedBy),
    decision: value.decision,
    reason: requiredString(value.reason),
    approvedFiles: requiredReviewedFileList(value.approvedFiles, {
      allowEmpty: options.allowEmptyApprovedFiles === true,
    }),
    requiredChecks: parseRequiredChecks(value.requiredChecks),
  };
}

function isReviewDecisionStatus(value: unknown): value is ReviewDecisionStatus {
  return (
    value === ReviewDecisionStatus.Approved ||
    value === ReviewDecisionStatus.Rejected ||
    value === ReviewDecisionStatus.NeedsHuman
  );
}

function parseRequiredChecks(value: unknown): ReviewDecision["requiredChecks"] {
  if (!Array.isArray(value)) {
    throw new Error("reviewed_worker_output_review_invalid");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("reviewed_worker_output_review_invalid");
    }
    assertExactKeys(item, ["checkId", "command", "cwd", "timeoutMs"]);
    const timeoutMs = item.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs <= 0)
    ) {
      throw new Error("reviewed_worker_output_review_invalid");
    }
    return {
      checkId: requiredString(item.checkId),
      command: requiredStringArray(item.command),
      ...(item.cwd === undefined ? {} : { cwd: requiredString(item.cwd) }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  });
}

function parseReviewAttestation(
  value: unknown,
): ReviewedWorkerOutputReviewAttestation {
  if (!isRecord(value)) {
    throw new Error("reviewed_worker_output_review_attestation_invalid");
  }
  assertExactKeys(value, [
    "format",
    "formatRevision",
    "reviewedOutputId",
    "reviewMarkerPath",
    "reviewMarkerSha256",
    "committedAt",
  ]);
  if (
    value.format !== "reviewed-worker-output-review-attestation" ||
    value.formatRevision !== 1
  ) {
    throw new Error("reviewed_worker_output_review_attestation_invalid");
  }
  const attestation: ReviewedWorkerOutputReviewAttestation = {
    format: "reviewed-worker-output-review-attestation",
    formatRevision: 1,
    reviewedOutputId: requiredString(value.reviewedOutputId),
    reviewMarkerPath: requiredString(value.reviewMarkerPath),
    reviewMarkerSha256: requiredString(value.reviewMarkerSha256),
    committedAt: requiredString(value.committedAt),
  };
  assertSha256(attestation.reviewedOutputId);
  assertSha256(attestation.reviewMarkerSha256);
  return attestation;
}

function parseLegacyApproval(value: unknown): {
  readonly reviewedOutputId: string;
  readonly reviewMarkerPath: string;
  readonly reviewMarkerSha256: string;
  readonly committedAt: string;
} {
  if (!isRecord(value)) {
    throw new Error("reviewed_worker_output_legacy_approval_invalid");
  }
  assertExactKeys(value, [
    "format",
    "formatRevision",
    "reviewedOutputId",
    "reviewMarkerPath",
    "reviewMarkerSha256",
    "committedAt",
  ]);
  if (
    value.format !== "reviewed-worker-output-approval" ||
    value.formatRevision !== 1
  ) {
    throw new Error("reviewed_worker_output_legacy_approval_invalid");
  }
  const legacy = {
    reviewedOutputId: requiredString(value.reviewedOutputId),
    reviewMarkerPath: requiredString(value.reviewMarkerPath),
    reviewMarkerSha256: requiredString(value.reviewMarkerSha256),
    committedAt: requiredString(value.committedAt),
  };
  assertSha256(legacy.reviewedOutputId);
  assertSha256(legacy.reviewMarkerSha256);
  return legacy;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
}

function requiredStringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
}

function requiredReviewedFileList(
  value: unknown,
  options: { readonly allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxReviewedInputFiles) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  const files = requiredStringArray(value).map(assertReviewedPath);
  const normalized = [...new Set(files)].sort();
  if (
    (options.allowEmpty !== true && normalized.length === 0) ||
    normalized.length > maxReviewedChangedFiles
  ) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return normalized;
}

function assertReviewedFileList(
  value: readonly string[],
  options: { readonly allowEmpty?: boolean } = {},
): void {
  if (
    value.length > maxReviewedInputFiles ||
    value.some((path) => {
      try {
        assertReviewedPath(path);
        return false;
      } catch {
        return true;
      }
    }) ||
    (options.allowEmpty !== true && [...new Set(value)].length === 0) ||
    [...new Set(value)].length > maxReviewedChangedFiles
  ) {
    throw new Error("reviewed_worker_output_changed_file_limit_exceeded");
  }
}

function assertReviewedPath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("reviewed_worker_output_changed_path_invalid");
  }
  return path;
}

function requiredNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
}

function assertReviewedPatchInvariant(
  snapshot: Pick<
    ReviewedWorkerOutputSnapshot,
    | "patchByteLength"
    | "patchSha256"
    | "baseCommit"
    | "changedFiles"
    | "reviewDecision"
    | "merge"
  >,
  patch?: string,
): void {
  if (snapshot.patchByteLength === 0) {
    if (
      snapshot.merge === undefined ||
      snapshot.changedFiles.length !== 0 ||
      (patch !== undefined && patch.length !== 0)
    ) {
      throw new Error("reviewed_worker_output_patch_required");
    }
    if (
      snapshot.reviewDecision.approvedFiles.length === 0 &&
      (
        snapshot.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
        snapshot.patchSha256 !== emptyReviewedPatchSha256 ||
        snapshot.baseCommit !== snapshot.merge.expectedTargetCommit ||
        snapshot.reviewDecision.requiredChecks.length === 0
      )
    ) {
      throw new Error(
        "reviewed_worker_output_topology_only_merge_envelope_required",
      );
    }
    return;
  }
  if (snapshot.changedFiles.length === 0) {
    throw new Error("reviewed_worker_output_changed_files_required");
  }
}

function isTopologyOnlyReviewedSnapshot(
  snapshot: Pick<
    ReviewedWorkerOutputSnapshot,
    "merge" | "changedFiles" | "reviewDecision"
  >,
): boolean {
  return snapshot.merge !== undefined &&
    snapshot.changedFiles.length === 0 &&
    snapshot.reviewDecision.approvedFiles.length === 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("reviewed_worker_output_sha256_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("reviewed_worker_output_unknown_manifest_field");
  }
}

function isMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameReviewedOutput(
  existing: ReviewedWorkerOutputSnapshot,
  candidate: ReviewedWorkerOutputSnapshot,
): boolean {
  const { capturedAt: _existingCapturedAt, ...existingStable } = existing;
  const { capturedAt: _candidateCapturedAt, ...candidateStable } = candidate;
  return stableJson(existingStable) === stableJson(candidateStable);
}
