import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  captureCodexGoalHandoffPatchFingerprint,
  DEFAULT_HANDOFF_ARTIFACT_LIMITS,
} from "../../codex-goal-handoff-artifacts";
import { readControlledRuntimeInterruptionEvidence } from "../../codex-goal-runtime-control-evidence";
import { assertGitPatchBlobsSecretSafe } from "../../git-patch-secret-validator";
import { readRuntimeResultBrief } from "../codex-goal-runtime-result";
import { isCodexAppServerReconnectTimeoutCause } from "./codex-goal-project-provider-failure";

const execFileAsync = promisify(execFile);
const maxManifestBytes = 1024 * 1024;
const maxPatchBytes = 16 * 1024 * 1024;
const runtimePreservedContinuationReasons = new Set([
  "runtime_interrupted",
  "quota_limited",
  "capacity_unavailable",
  "account_unavailable",
  "reconnect_required",
]);
const runtimeContinuationFingerprintErrors = new Set([
  "handoff_raw_secret_rejected",
  "handoff_changed_file_limit_exceeded",
]);

export type VerifiedProducerHandoff = {
  readonly producerJobId: string;
  readonly resultPath?: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly patchByteLength: number;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
};

export type ControlledRuntimeInterruptionSnapshot = {
  readonly kind: "materialized_handoff" | "continuation_fingerprint";
  readonly producerJobId: string;
  readonly resultPath?: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly sha256: string;
};

export async function readVerifiedProducerHandoff(input: {
  readonly producer: CodexGoalJobManifest;
}): Promise<VerifiedProducerHandoff> {
  return readProducerHandoff({
    producer: input.producer,
    allowProviderOutputInvalid: false,
    allowTerminalTaskTimeout: true,
  });
}

/**
 * Reads a terminal producer patch for independent verification. A provider may
 * fail to serialize its final envelope after the runtime has already captured
 * an immutable handoff. That failure is not completion or approval: it only
 * makes the hash-bound patch eligible to be inspected by a verifier.
 */
export async function readVerifiableProducerHandoff(input: {
  readonly producer: CodexGoalJobManifest;
}): Promise<VerifiedProducerHandoff> {
  const handoff = await readProducerHandoff({
    producer: input.producer,
    allowProviderOutputInvalid: true,
    allowRuntimeInterrupted: true,
    allowTerminalTaskTimeout: true,
  });
  await assertProducerHandoffMatchesWorkspace(input.producer, handoff);
  return handoff;
}

/**
 * Reads the immutable workspace snapshot captured by the runtime when a
 * broker-owned interrupt or bounded task timeout stopped an admitted worker.
 * This is continuation evidence only; it is never completion or review
 * approval.
 */
export async function readControlledRuntimeInterruptionHandoff(input: {
  readonly producer: CodexGoalJobManifest;
}): Promise<VerifiedProducerHandoff> {
  return readProducerHandoff({
    producer: input.producer,
    allowProviderOutputInvalid: false,
    allowControlledRuntimeInterruption: true,
  });
}

/** Hash-only snapshots prove same-workspace continuation, never reviewable output. */
export async function readControlledRuntimeInterruptionSnapshot(input: {
  readonly producer: CodexGoalJobManifest;
  readonly allowCompletedRejectedUncaptured?: boolean;
}): Promise<ControlledRuntimeInterruptionSnapshot> {
  const producerJobRoot = await canonicalDirectory(input.producer.jobRootDir);
  const requestedResultPath =
    input.producer.outputPath ??
    join(producerJobRoot, `${input.producer.taskId}.latest-result.json`);
  let resultPath: string;
  try {
    resultPath = await realpath(requestedResultPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(
        "project_control_runtime_interruption_handoff_result_required",
      );
    }
    throw error;
  }
  if (!pathInside(producerJobRoot, resultPath)) {
    throw new Error("project_control_verifier_handoff_result_unowned");
  }
  const result = await readRuntimeResultBrief(resultPath);
  if (result.handoffArtifactError === undefined) {
    const handoff = await readControlledRuntimeInterruptionHandoff(input);
    return {
      kind: "materialized_handoff",
      producerJobId: handoff.producerJobId,
      ...(handoff.resultPath ? { resultPath: handoff.resultPath } : {}),
      baseCommit: handoff.baseCommit,
      changedPaths: handoff.changedPaths,
      sha256: handoff.patchSha256,
    };
  }
  const fingerprint = result.continuationWorkspaceFingerprint;
  const controlledInterruptionEvidence =
    await readControlledRuntimeInterruptionEvidence({
      resultPath,
      taskId: input.producer.taskId,
    });
  const controlledRuntimeInterruption =
    result.lastFailureReason === "runtime_interrupted" &&
    controlledInterruptionEvidence !== undefined;
  const terminalTaskTimeout = result.lastFailureReason === "task_timeout";
  const completedRejectedUncaptured =
    input.allowCompletedRejectedUncaptured === true && result.status === "done";
  if (
    !runtimeContinuationFingerprintErrors.has(result.handoffArtifactError) ||
    result.strict !== true ||
    (result.status !== "partial" && !completedRejectedUncaptured) ||
    (!controlledRuntimeInterruption &&
      !terminalTaskTimeout &&
      !completedRejectedUncaptured) ||
    !result.baseCommit ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(result.baseCommit) ||
    !result.changedFiles?.length ||
    fingerprint === undefined ||
    result.patchPath !== undefined ||
    result.summaryPath !== undefined ||
    result.manifestPath !== undefined
  ) {
    throw new Error(
      `project_control_runtime_interruption_snapshot_unavailable:${result.handoffArtifactError}`,
    );
  }
  return {
    kind: "continuation_fingerprint",
    producerJobId: input.producer.jobId,
    resultPath,
    baseCommit: result.baseCommit.toLowerCase(),
    changedPaths: uniqueSorted(result.changedFiles),
    sha256: fingerprint.sha256,
  };
}

async function readProducerHandoff(input: {
  readonly producer: CodexGoalJobManifest;
  readonly allowProviderOutputInvalid: boolean;
  readonly allowControlledRuntimeInterruption?: boolean;
  readonly allowRuntimeInterrupted?: boolean;
  readonly allowTerminalTaskTimeout?: boolean;
}): Promise<VerifiedProducerHandoff> {
  const producerJobRoot = await canonicalDirectory(input.producer.jobRootDir);
  const producerWorkspace = await canonicalDirectory(
    input.producer.workspacePath,
  );
  const resultHandoff = await currentResultHandoff({
    producer: input.producer,
    producerJobRoot,
    allowProviderOutputInvalid: input.allowProviderOutputInvalid,
    allowControlledRuntimeInterruption:
      input.allowControlledRuntimeInterruption === true,
    allowRuntimeInterrupted: input.allowRuntimeInterrupted === true,
    allowTerminalTaskTimeout: input.allowTerminalTaskTimeout === true,
  });
  const manifestPath = await realpath(
    resultHandoff?.manifestPath ??
      join(producerJobRoot, `${input.producer.taskId}.handoff.manifest.json`),
  );
  if (!pathInside(producerJobRoot, manifestPath)) {
    throw new Error("project_control_verifier_handoff_manifest_unowned");
  }
  const manifestFile = await readRegularFile(manifestPath, maxManifestBytes);
  if (
    resultHandoff &&
    resultHandoff.manifestSha256 !== sha256(manifestFile.bytes)
  ) {
    throw new Error(
      "project_control_verifier_handoff_result_manifest_mismatch",
    );
  }
  const manifest = parseManifest(manifestFile.bytes);
  if (
    manifest.workerJobId !== input.producer.jobId ||
    manifest.taskId !== input.producer.taskId ||
    manifest.workspacePath !== producerWorkspace ||
    manifest.jobRootDir !== producerJobRoot ||
    manifest.provenance.baseCommit !== manifest.baseCommit
  ) {
    throw new Error("project_control_verifier_handoff_identity_mismatch");
  }
  const patchPath = await realpath(manifest.artifacts.patch.path);
  if (!pathInside(producerJobRoot, patchPath)) {
    throw new Error("project_control_verifier_handoff_patch_unowned");
  }
  const patchFile = await readRegularFile(patchPath, maxPatchBytes);
  assertDescriptor(manifest.artifacts.patch, patchPath, patchFile.bytes);
  await assertProducerHandoffSecretSafe({
    producerWorkspace,
    producerJobRoot,
    manifest,
    patchPath,
  });
  const changedPaths = await patchChangedPaths(producerWorkspace, patchPath);
  if (!sameStrings(changedPaths, manifest.changedPaths)) {
    throw new Error("project_control_verifier_handoff_changed_paths_mismatch");
  }
  if (
    resultHandoff?.changedFiles &&
    !sameStrings(changedPaths, resultHandoff.changedFiles)
  ) {
    throw new Error("project_control_verifier_handoff_result_paths_mismatch");
  }
  return {
    producerJobId: input.producer.jobId,
    ...(resultHandoff ? { resultPath: resultHandoff.resultPath } : {}),
    manifestPath,
    manifestSha256: sha256(manifestFile.bytes),
    patchPath,
    patchSha256: manifest.artifacts.patch.sha256,
    patchByteLength: patchFile.bytes.byteLength,
    baseCommit: manifest.baseCommit,
    changedPaths,
  };
}

async function assertProducerHandoffSecretSafe(input: {
  readonly producerWorkspace: string;
  readonly producerJobRoot: string;
  readonly manifest: ParsedManifest;
  readonly patchPath: string;
}): Promise<void> {
  try {
    await assertGitPatchBlobsSecretSafe({
      workspacePath: input.producerWorkspace,
      baseCommit: input.manifest.baseCommit,
      patchPath: input.patchPath,
      changedPaths: input.manifest.changedPaths,
      tempRootDir: input.producerJobRoot,
      maxFileBytes: DEFAULT_HANDOFF_ARTIFACT_LIMITS.maxFileBytes,
      maxTotalFileBytes: DEFAULT_HANDOFF_ARTIFACT_LIMITS.maxTotalFileBytes,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("git_patch_secret_like_content:")
    ) {
      throw new Error("project_control_verifier_handoff_secret_like_content");
    }
    throw new Error("project_control_verifier_handoff_blob_validation_failed");
  }
}

async function currentResultHandoff(input: {
  readonly producer: CodexGoalJobManifest;
  readonly producerJobRoot: string;
  readonly allowProviderOutputInvalid: boolean;
  readonly allowControlledRuntimeInterruption: boolean;
  readonly allowRuntimeInterrupted: boolean;
  readonly allowTerminalTaskTimeout: boolean;
}): Promise<
  | {
      readonly resultPath: string;
      readonly manifestPath: string;
      readonly manifestSha256: string;
      readonly changedFiles?: readonly string[];
    }
  | undefined
> {
  const requestedResultPath =
    input.producer.outputPath ??
    join(input.producerJobRoot, `${input.producer.taskId}.latest-result.json`);
  let resultPath: string;
  try {
    resultPath = await realpath(requestedResultPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      if (input.allowControlledRuntimeInterruption) {
        throw new Error(
          "project_control_runtime_interruption_handoff_result_required",
        );
      }
      return undefined;
    }
    throw error;
  }
  if (!pathInside(input.producerJobRoot, resultPath)) {
    throw new Error("project_control_verifier_handoff_result_unowned");
  }
  const result = await readRuntimeResultBrief(resultPath);
  const completed =
    !input.allowControlledRuntimeInterruption && result.status === "done";
  const verifiableProviderOutputFailure =
    input.allowProviderOutputInvalid &&
    (result.status === "failed" || result.status === "partial") &&
    result.lastFailureReason === "provider_output_invalid" &&
    result.handoffArtifactError === undefined;
  const runtimePreservedContinuation =
    input.allowControlledRuntimeInterruption &&
    result.status === "partial" &&
    runtimePreservedContinuationReasons.has(result.lastFailureReason ?? "") &&
    result.handoffArtifactError === undefined;
  const verifiableRuntimeInterruption =
    input.allowRuntimeInterrupted &&
    result.status === "partial" &&
    result.lastFailureReason === "runtime_interrupted" &&
    result.handoffArtifactError === undefined;
  const terminalTaskTimeout =
    input.allowTerminalTaskTimeout &&
    result.status === "partial" &&
    result.lastFailureReason === "task_timeout" &&
    result.handoffArtifactError === undefined;
  const verifiablePreservedReconnectFailure =
    input.allowProviderOutputInvalid &&
    result.status === "failed" &&
    result.lastFailureReason === "unknown_error" &&
    isCodexAppServerReconnectTimeoutCause(result.lastFailureRawCause) &&
    result.handoffArtifactError === undefined;
  const manifestHandoff = terminalTaskTimeout
    ? uniqueManifestArtifact(result.artifacts)
    : (resultManifestHandoff(result) ??
      (await topLevelResultManifestHandoff(resultPath)));
  if (
    result.strict !== true ||
    (!completed &&
      !verifiableProviderOutputFailure &&
      !runtimePreservedContinuation &&
      !verifiableRuntimeInterruption &&
      !terminalTaskTimeout &&
      !verifiablePreservedReconnectFailure) ||
    manifestHandoff === undefined
  ) {
    throw new Error("project_control_verifier_handoff_result_invalid");
  }
  return {
    resultPath,
    manifestPath: manifestHandoff.path,
    manifestSha256: manifestHandoff.sha256,
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
  };
}

async function topLevelResultManifestHandoff(
  resultPath: string,
): Promise<{ readonly path: string; readonly sha256: string } | undefined> {
  let result: unknown;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isRecord(result) ||
    typeof result.manifestPath !== "string" ||
    !isAbsolute(result.manifestPath)
  ) {
    return undefined;
  }
  return resultManifestHandoff(result);
}

function resultManifestHandoff(input: {
  readonly manifestPath?: unknown;
  readonly manifestSha256?: unknown;
}): { readonly path: string; readonly sha256: string } | undefined {
  if (
    typeof input.manifestPath !== "string" ||
    !input.manifestPath ||
    typeof input.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(input.manifestSha256)
  ) {
    return undefined;
  }
  return {
    path: input.manifestPath,
    sha256: input.manifestSha256.toLowerCase(),
  };
}

function uniqueManifestArtifact(
  artifacts:
    | readonly {
        readonly kind: string;
        readonly path?: string;
        readonly sha256?: string;
      }[]
    | undefined,
): { readonly path: string; readonly sha256: string } | undefined {
  const manifests = artifacts?.filter(
    (artifact) => artifact.kind === "manifest",
  );
  if (manifests?.length !== 1) return undefined;
  const manifest = manifests[0];
  if (
    manifest === undefined ||
    typeof manifest.path !== "string" ||
    !isAbsolute(manifest.path) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.sha256)
  ) {
    return undefined;
  }
  return {
    path: manifest.path,
    sha256: manifest.sha256.toLowerCase(),
  };
}

async function assertProducerHandoffMatchesWorkspace(
  producer: CodexGoalJobManifest,
  handoff: VerifiedProducerHandoff,
): Promise<void> {
  let current;
  try {
    current = await captureCodexGoalHandoffPatchFingerprint({
      workspacePath: producer.workspacePath,
      expectedBaseCommit: handoff.baseCommit,
    });
  } catch {
    throw new Error(
      "project_control_verifier_handoff_workspace_changed_after_capture",
    );
  }
  if (
    !current ||
    current.baseCommit !== handoff.baseCommit ||
    current.patchSha256 !== handoff.patchSha256 ||
    !sameStrings(current.changedPaths, handoff.changedPaths)
  ) {
    throw new Error(
      "project_control_verifier_handoff_workspace_changed_after_capture",
    );
  }
}

type ParsedManifest = {
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly provenance: { readonly baseCommit: string };
  readonly artifacts: { readonly patch: ArtifactDescriptor };
};

type ArtifactDescriptor = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

function parseManifest(bytes: Buffer): ParsedManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("project_control_verifier_handoff_manifest_invalid");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "subscription-runtime-worker-handoff" ||
    typeof value.workerJobId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.jobRootDir !== "string" ||
    typeof value.baseCommit !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.baseCommit) ||
    !Array.isArray(value.changedPaths) ||
    !value.changedPaths.every((path) => typeof path === "string") ||
    !isRecord(value.provenance) ||
    value.provenance.generator !== "subscription-runtime" ||
    value.provenance.source !== "terminal-worker-workspace" ||
    typeof value.provenance.baseCommit !== "string" ||
    !isRecord(value.artifacts)
  ) {
    throw new Error("project_control_verifier_handoff_manifest_invalid");
  }
  return {
    workerJobId: value.workerJobId,
    taskId: value.taskId,
    workspacePath: value.workspacePath,
    jobRootDir: value.jobRootDir,
    baseCommit: value.baseCommit,
    changedPaths: uniqueSorted(value.changedPaths.map(assertSafeChangedPath)),
    provenance: { baseCommit: value.provenance.baseCommit },
    artifacts: { patch: parseDescriptor(value.artifacts.patch) },
  };
}

function parseDescriptor(value: unknown): ArtifactDescriptor {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.sha256)
  ) {
    throw new Error("project_control_verifier_handoff_descriptor_invalid");
  }
  return {
    path: value.path,
    byteLength: value.byteLength,
    sha256: value.sha256.toLowerCase(),
  };
}

function assertDescriptor(
  descriptor: ArtifactDescriptor,
  canonicalPath: string,
  bytes: Buffer,
): void {
  if (
    descriptor.path !== canonicalPath ||
    descriptor.byteLength !== bytes.byteLength ||
    descriptor.sha256 !== sha256(bytes)
  ) {
    throw new Error("project_control_verifier_handoff_descriptor_mismatch");
  }
}

async function patchChangedPaths(
  workspacePath: string,
  patchPath: string,
): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "apply", "--numstat", "-z", patchPath],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return uniqueSorted(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const fields = record.split("\t");
        return assertSafeChangedPath(fields.slice(2).join("\t"));
      }),
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isDirectory()) {
    throw new Error("project_control_verifier_handoff_directory_unsafe");
  }
  return realpath(path);
}

async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer }> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isFile() || item.size > maxBytes) {
    throw new Error("project_control_verifier_handoff_artifact_unsafe");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error("project_control_verifier_handoff_artifact_unsafe");
  }
  return { bytes };
}

function assertSafeChangedPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("project_control_verifier_handoff_changed_path_invalid");
  }
  return path;
}

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
