import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  detectSecretLikeContent,
  ReviewDecisionStatus,
  type ReviewDecision,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalGitIntegrationAdapter,
  LocalWorkspaceIntegrationLock,
} from "@vioxen/subscription-runtime/worker-local";
import { readLocalGitHeadCommit } from "../../codex-goal-git-revision";
import { captureGitWorkspacePatch } from "../../codex-goal-runtime-result-io";
import {
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputFormat,
  type ReviewedWorkerOutputApproval,
  type ReviewedWorkerOutputSnapshot,
  type ReviewedWorkerOutputWorkspaceSnapshot,
} from "../domain/reviewed-worker-output";
import type {
  ReviewedWorkerOutputReviewMarkerVerifierPort,
  ReviewedWorkerOutputSnapshotterPort,
  ReviewedWorkerOutputStorePort,
} from "../ports/reviewed-worker-output-ports";

const execFileAsync = promisify(execFile);

export class GitReviewedWorkerOutputSnapshotter
  implements ReviewedWorkerOutputSnapshotterPort {
  constructor(private readonly options: {
    readonly tempRootDir: string;
    readonly gitBinaryPath?: string;
  }) {}

  async capture(input: {
    readonly workspacePath: string;
  }): Promise<ReviewedWorkerOutputWorkspaceSnapshot> {
    const baseCommit = await readLocalGitHeadCommit(input.workspacePath);
    if (!baseCommit) throw new Error("reviewed_worker_output_base_commit_required");
    const patch = await captureGitWorkspacePatch({
      workspacePath: input.workspacePath,
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    if (!patch.trim()) throw new Error("reviewed_worker_output_patch_required");
    if (detectSecretLikeContent(Buffer.from(patch)) !== undefined) {
      throw new Error("reviewed_worker_output_secret_like_content");
    }
    const status = await new LocalGitIntegrationAdapter({
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    }).getStatus({ workspacePath: input.workspacePath });
    if (status.dirtyFiles.length === 0) {
      throw new Error("reviewed_worker_output_changed_files_required");
    }
    await this.assertPatchAppliesToBase({
      workspacePath: input.workspacePath,
      baseCommit,
      patch,
    });
    return {
      patch,
      baseCommit,
      changedFiles: status.dirtyFiles,
    };
  }

  private async assertPatchAppliesToBase(input: {
    readonly workspacePath: string;
    readonly baseCommit: string;
    readonly patch: string;
  }): Promise<void> {
    await mkdir(this.options.tempRootDir, { recursive: true, mode: 0o700 });
    const tempDir = await mkdtemp(join(this.options.tempRootDir, ".capture-"));
    const patchPath = join(tempDir, "output.patch");
    const indexPath = join(tempDir, "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await writeFile(patchPath, input.patch, { encoding: "utf8", mode: 0o600 });
      await execFileAsync(this.options.gitBinaryPath ?? "git", [
        "-C",
        input.workspacePath,
        "read-tree",
        input.baseCommit,
      ], { env, timeout: 10_000 });
      await execFileAsync(this.options.gitBinaryPath ?? "git", [
        "-C",
        input.workspacePath,
        "apply",
        "--cached",
        "--check",
        "--whitespace=nowarn",
        patchPath,
      ], { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
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
    const patchSha256 = sha256(input.patch);
    if (patchSha256 !== input.snapshot.patchSha256) {
      throw new Error("reviewed_worker_output_store_patch_hash_mismatch");
    }
    if (Buffer.byteLength(input.patch) !== input.snapshot.patchByteLength) {
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

  async commitApproval(input: {
    readonly approval: ReviewedWorkerOutputApproval;
    readonly reviewMarkerContent: string;
  }): Promise<void> {
    assertSha256(input.approval.reviewedOutputId);
    assertSha256(input.approval.reviewMarkerSha256);
    if (sha256(input.reviewMarkerContent) !== input.approval.reviewMarkerSha256) {
      throw new Error("reviewed_worker_output_review_marker_hash_mismatch");
    }
    const snapshot = await this.readSnapshot(input.approval.reviewedOutputId);
    if (!snapshot) throw new Error("reviewed_worker_output_not_found");
    const itemDir = this.itemDir(input.approval.reviewedOutputId);
    const approvalPath = join(itemDir, "approval.json");
    const existing = await this.readApproval(approvalPath);
    if (existing) {
      if (existing.reviewedOutputId !== input.approval.reviewedOutputId) {
        throw new Error("reviewed_worker_output_approval_conflict");
      }
      const markerCopy = await readFile(
        this.reviewMarkerCopyPath(itemDir, existing.reviewMarkerSha256),
        "utf8",
      );
      if (sha256(markerCopy) !== existing.reviewMarkerSha256) {
        throw new Error("reviewed_worker_output_approval_marker_hash_mismatch");
      }
      return;
    }
    const markerCopyPath = this.reviewMarkerCopyPath(
      itemDir,
      input.approval.reviewMarkerSha256,
    );
    await this.writeImmutableFile(markerCopyPath, input.reviewMarkerContent);
    const tempPath = join(
      itemDir,
      `.approval-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, `${JSON.stringify(input.approval, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(tempPath, approvalPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    } finally {
      await rm(tempPath, { force: true });
    }
    const committed = await this.readApproval(approvalPath);
    if (
      !committed ||
      committed.reviewedOutputId !== input.approval.reviewedOutputId
    ) {
      throw new Error("reviewed_worker_output_approval_commit_failed");
    }
  }

  async get(
    reviewedOutputId: string,
  ): Promise<ReviewedWorkerOutputSnapshot | undefined> {
    const snapshot = await this.readSnapshot(reviewedOutputId);
    if (!snapshot) return undefined;
    const approval = await this.readApproval(
      join(this.itemDir(reviewedOutputId), "approval.json"),
    );
    if (!approval) return undefined;
    if (approval.reviewedOutputId !== reviewedOutputId) {
      throw new Error("reviewed_worker_output_approval_id_mismatch");
    }
    const markerCopy = await readFile(
      this.reviewMarkerCopyPath(
        this.itemDir(reviewedOutputId),
        approval.reviewMarkerSha256,
      ),
      "utf8",
    );
    if (sha256(markerCopy) !== approval.reviewMarkerSha256) {
      throw new Error("reviewed_worker_output_approval_marker_hash_mismatch");
    }
    return snapshot;
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
      const [rawManifest, patch] = await Promise.all([
        readFile(manifestPath, "utf8"),
        readFile(patchPath, "utf8"),
      ]);
      const snapshot = parseSnapshot(rawManifest, patchPath);
      if (snapshot.reviewedOutputId !== reviewedOutputId) {
        throw new Error("reviewed_worker_output_manifest_id_mismatch");
      }
      if (sha256(reviewedWorkerOutputIdentityPayload({
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
      })) !== reviewedOutputId) {
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

  private async readApproval(
    approvalPath: string,
  ): Promise<ReviewedWorkerOutputApproval | undefined> {
    try {
      const value = JSON.parse(await readFile(approvalPath, "utf8")) as unknown;
      return parseApproval(value);
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

  private async writeImmutableFile(path: string, content: string): Promise<void> {
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
    if (await readFile(path, "utf8") !== content) {
      throw new Error("reviewed_worker_output_immutable_conflict");
    }
  }
}

export class LocalReviewedWorkerOutputReviewMarkerVerifier
  implements ReviewedWorkerOutputReviewMarkerVerifierPort {
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
      "capturedAt",
    ]);
    if (
      value.reviewedOutput.reviewedOutputId !== input.snapshot.reviewedOutputId ||
      value.reviewedOutput.patchSha256 !== input.snapshot.patchSha256 ||
      value.reviewedOutput.patchPath !== input.snapshot.patchPath ||
      value.reviewedOutput.baseCommit !== input.snapshot.baseCommit ||
      stableJson(value.reviewedOutput.changedFiles) !==
        stableJson(input.snapshot.changedFiles) ||
      value.reviewedOutput.reviewedBy !== input.snapshot.reviewDecision.reviewedBy ||
      value.reviewedOutput.capturedAt !== input.snapshot.capturedAt
    ) {
      throw new Error("reviewed_worker_output_review_marker_mismatch");
    }
    return { markerSha256: sha256(raw), markerContent: raw };
  }
}

export function localReviewedWorkerOutputDeps(input: {
  readonly rootDir: string;
}) {
  return {
    snapshotter: new GitReviewedWorkerOutputSnapshotter({
      tempRootDir: join(input.rootDir, ".captures"),
    }),
    store: new LocalReviewedWorkerOutputStore({ rootDir: input.rootDir }),
    markerVerifier: new LocalReviewedWorkerOutputReviewMarkerVerifier(),
    locks: new LocalWorkspaceIntegrationLock({
      rootDir: join(input.rootDir, ".locks"),
      staleLockMs: 30 * 60_000,
    }),
  };
}

export function reviewedWorkerOutputRoot(registryRootDir: string): string {
  return join(dirname(registryRootDir), "reviewed-worker-outputs");
}

function parseSnapshot(raw: string, patchPath: string): ReviewedWorkerOutputSnapshot {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) throw new Error("reviewed_worker_output_manifest_invalid");
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
    "capturedAt",
  ]);
  const reviewDecision = parseReviewDecision(value.reviewDecision);
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
    patchByteLength: requiredPositiveInteger(value.patchByteLength),
    baseCommit: requiredString(value.baseCommit),
    changedFiles: requiredStringArray(value.changedFiles),
    reviewDecision,
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
  return snapshot;
}

function parseReviewDecision(value: unknown): ReviewDecision {
  if (!isRecord(value) || value.decision !== ReviewDecisionStatus.Approved) {
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
    decision: ReviewDecisionStatus.Approved,
    reason: requiredString(value.reason),
    approvedFiles: requiredStringArray(value.approvedFiles),
    requiredChecks: parseRequiredChecks(value.requiredChecks),
  };
}

function parseRequiredChecks(
  value: unknown,
): ReviewDecision["requiredChecks"] {
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
      (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
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

function parseApproval(value: unknown): ReviewedWorkerOutputApproval {
  if (!isRecord(value)) {
    throw new Error("reviewed_worker_output_approval_invalid");
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
    throw new Error("reviewed_worker_output_approval_invalid");
  }
  const approval: ReviewedWorkerOutputApproval = {
    format: "reviewed-worker-output-approval",
    formatRevision: 1,
    reviewedOutputId: requiredString(value.reviewedOutputId),
    reviewMarkerPath: requiredString(value.reviewMarkerPath),
    reviewMarkerSha256: requiredString(value.reviewMarkerSha256),
    committedAt: requiredString(value.committedAt),
  };
  assertSha256(approval.reviewedOutputId);
  assertSha256(approval.reviewMarkerSha256);
  return approval;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
}

function requiredStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) =>
    typeof item === "string" && item.length > 0
  )) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("reviewed_worker_output_manifest_invalid");
  }
  return value;
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
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
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
