import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { detectSecretLikeContent } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { readRuntimeResultBrief } from "../codex-goal-runtime-result";

const execFileAsync = promisify(execFile);
const maxManifestBytes = 1024 * 1024;
const maxPatchBytes = 16 * 1024 * 1024;

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

export async function readVerifiedProducerHandoff(input: {
  readonly producer: CodexGoalJobManifest;
}): Promise<VerifiedProducerHandoff> {
  return readProducerHandoff({
    producer: input.producer,
    allowProviderOutputInvalid: false,
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
  return readProducerHandoff({
    producer: input.producer,
    allowProviderOutputInvalid: true,
  });
}

/**
 * Reads the immutable workspace snapshot captured by the runtime when a
 * broker-owned interrupt stopped an admitted worker. This is continuation
 * evidence only; it is never completion or review approval.
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

async function readProducerHandoff(input: {
  readonly producer: CodexGoalJobManifest;
  readonly allowProviderOutputInvalid: boolean;
  readonly allowControlledRuntimeInterruption?: boolean;
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
  if (detectSecretLikeContent(patchFile.bytes) !== undefined) {
    throw new Error("project_control_verifier_handoff_secret_like_content");
  }
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

async function currentResultHandoff(input: {
  readonly producer: CodexGoalJobManifest;
  readonly producerJobRoot: string;
  readonly allowProviderOutputInvalid: boolean;
  readonly allowControlledRuntimeInterruption: boolean;
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
  const controlledRuntimeInterruption =
    input.allowControlledRuntimeInterruption &&
    result.status === "partial" &&
    result.lastFailureReason === "runtime_interrupted" &&
    result.handoffArtifactError === undefined;
  if (
    result.strict !== true ||
    (!completed &&
      !verifiableProviderOutputFailure &&
      !controlledRuntimeInterruption) ||
    !result.manifestPath ||
    !result.manifestSha256 ||
    !/^[0-9a-f]{64}$/i.test(result.manifestSha256)
  ) {
    throw new Error("project_control_verifier_handoff_result_invalid");
  }
  return {
    resultPath,
    manifestPath: result.manifestPath,
    manifestSha256: result.manifestSha256.toLowerCase(),
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
  };
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
