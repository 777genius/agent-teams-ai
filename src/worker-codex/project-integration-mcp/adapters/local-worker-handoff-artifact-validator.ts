import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

import { assertGitPatchBlobsSecretSafe } from "../../git-patch-secret-validator";
import type { ProjectIntegrationMcpController } from "../ports/project-integration-mcp-tool-handlers";

const execFileAsync = promisify(execFile);
const maxManifestBytes = 1024 * 1024;
const maxPatchBytes = 16 * 1024 * 1024;
const maxChangedPaths = 256;
const maxInputChangedPaths = 1024;

export type LocalRegisteredWorkerOwnership = {
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly projectAccessScope?: ProjectAccessScope;
};

export function localProjectIntegrationSnapshotRoot(
  controller: ProjectIntegrationMcpController,
): string {
  return join(
    controller.controller.jobRootDir,
    "project-integration",
    "artifact-snapshots",
  );
}

export async function validateLocalWorkerHandoffArtifact(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly attemptId: string;
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly summaryPath?: string;
  readonly manifestPath?: string;
  readonly manifestSha256?: string;
  readonly baseCommit?: string;
  readonly changedPaths: readonly string[];
  readonly registeredWorker?: LocalRegisteredWorkerOwnership;
}): Promise<{
  readonly baseCommit?: string;
  readonly manifestPath?: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly summaryPath?: string;
}> {
  assertSafeWorkerJobId(input.workerJobId);
  assertSafePathSegment(input.attemptId, "integration_attempt_id");
  const requestedChangedPaths = normalizeChangedPaths(input.changedPaths);
  const expectedJobRoot = await resolveWorkerJobRoot({
    controller: input.controller,
    workerJobId: input.workerJobId,
    workspacePath: input.workspacePath,
    ...(input.registeredWorker
      ? { registeredWorker: input.registeredWorker }
      : {}),
  });
  const patchFile = await readCanonicalRegularFile(
    input.patchPath,
    maxPatchBytes,
  );
  const patchPath = patchFile.path;
  const ownedByWorkerJob =
    expectedJobRoot !== undefined && pathInside(expectedJobRoot, patchPath);
  const ownedByControllerArchive = await patchInsideControllerRejectedArchive({
    controller: input.controller,
    workerJobId: input.workerJobId,
    patchPath,
  });
  if (
    !ownedByWorkerJob &&
    !ownedByControllerArchive &&
    !(await patchInsideProjectScope(input.controller, patchPath))
  ) {
    throw new Error(
      input.manifestPath || input.manifestSha256
        ? "project_integration_handoff_manifest_unowned_patch"
        : "project_integration_handoff_patch_unowned",
    );
  }
  const isManifestHandoff = basename(patchPath).endsWith(".handoff.patch");
  if (!isManifestHandoff) {
    if (input.manifestPath || input.manifestSha256) {
      throw new Error("project_integration_handoff_manifest_legacy_patch");
    }
    const snapshot = await snapshotValidatedPatch({
      controller: input.controller,
      attemptId: input.attemptId,
      bytes: patchFile.bytes,
    });
    await assertExactPatchChangedPaths({
      workspacePath: await realpath(input.workspacePath),
      patchPath: snapshot.path,
      expectedChangedPaths: requestedChangedPaths,
    });
    await assertValidatedPatchSecretSafe({
      controller: input.controller,
      workspacePath: await realpath(input.workspacePath),
      patchPath: snapshot.path,
      baseCommit: input.baseCommit ?? (await gitHead(input.workspacePath)),
      changedPaths: requestedChangedPaths,
    });
    return {
      patchPath: snapshot.path,
      patchSha256: snapshot.sha256,
    };
  }
  if (!ownedByWorkerJob) {
    throw new Error("project_integration_handoff_manifest_unowned_patch");
  }
  if (!input.manifestPath || !input.manifestSha256) {
    throw new Error("project_integration_handoff_manifest_required");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.manifestSha256)) {
    throw new Error("project_integration_handoff_manifest_hash_invalid");
  }
  const manifestFile = await readCanonicalRegularFile(
    input.manifestPath,
    maxManifestBytes,
  );
  const manifestPath = manifestFile.path;
  if (!pathInside(expectedJobRoot, manifestPath)) {
    throw new Error("project_integration_handoff_manifest_unowned");
  }
  const manifestBytes = manifestFile.bytes;
  if (sha256(manifestBytes) !== input.manifestSha256.toLowerCase()) {
    throw new Error("project_integration_handoff_manifest_hash_mismatch");
  }
  const manifest = parseManifest(manifestBytes);
  const workspacePath = await realpath(input.workspacePath);
  if (
    manifest.workerJobId !== input.workerJobId ||
    manifest.workspacePath !== workspacePath ||
    manifest.jobRootDir !== expectedJobRoot ||
    manifest.artifacts.patch.path !== patchPath
  ) {
    throw new Error("project_integration_handoff_manifest_ownership_mismatch");
  }
  if (input.baseCommit && manifest.baseCommit !== input.baseCommit) {
    throw new Error("project_integration_handoff_base_commit_mismatch");
  }
  if (manifest.provenance.baseCommit !== manifest.baseCommit) {
    throw new Error("project_integration_handoff_provenance_mismatch");
  }
  assertDescriptor(manifest.artifacts.patch, patchFile, maxPatchBytes);
  const summaryFile = await readCanonicalRegularFile(
    manifest.artifacts.summary.path,
    maxManifestBytes,
  );
  const summaryPath = summaryFile.path;
  if (!pathInside(expectedJobRoot, summaryPath)) {
    throw new Error("project_integration_handoff_summary_unowned");
  }
  if (
    input.summaryPath &&
    (await realpath(input.summaryPath)) !== summaryPath
  ) {
    throw new Error("project_integration_handoff_summary_mismatch");
  }
  assertDescriptor(manifest.artifacts.summary, summaryFile, maxManifestBytes);
  const manifestChangedPaths = uniqueSorted(
    manifest.changedPaths.map(assertSafeChangedPath),
  );
  const snapshot = await snapshotValidatedPatch({
    controller: input.controller,
    attemptId: input.attemptId,
    bytes: patchFile.bytes,
  });
  const patchChangedPaths = await patchChangedPathsFromGit(
    workspacePath,
    snapshot.path,
  );
  if (
    !sameStrings(manifestChangedPaths, requestedChangedPaths) ||
    !sameStrings(manifestChangedPaths, patchChangedPaths)
  ) {
    throw new Error("project_integration_handoff_changed_paths_mismatch");
  }
  await assertValidatedPatchSecretSafe({
    controller: input.controller,
    workspacePath,
    patchPath: snapshot.path,
    baseCommit: manifest.baseCommit,
    changedPaths: manifestChangedPaths,
  });
  return {
    baseCommit: manifest.baseCommit,
    manifestPath,
    patchPath: snapshot.path,
    patchSha256: snapshot.sha256,
    summaryPath,
  };
}

async function resolveWorkerJobRoot(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly registeredWorker?: LocalRegisteredWorkerOwnership;
}): Promise<string | undefined> {
  const registryRoot = await requiredCanonicalDirectory(
    input.controller.registryRootDir,
    "project_integration_registry_root_missing",
  );
  const jobStorageRoot = await requiredCanonicalDirectory(
    dirname(registryRoot),
    "project_integration_job_storage_root_missing",
  );
  const requestedWorkspace = await requiredCanonicalDirectory(
    input.workspacePath,
    "project_integration_worker_workspace_missing",
  );
  if (
    !(await pathInsideDeclaredRoots(requestedWorkspace, [
      ...(input.controller.scope.workspaceRoots ?? []),
      ...(input.controller.scope.worktreeRoots ?? []),
    ]))
  ) {
    throw new Error("project_integration_worker_workspace_outside_scope");
  }

  const worker = input.registeredWorker;
  if (worker !== undefined) {
    if (worker.jobId !== input.workerJobId) {
      throw new Error("project_integration_worker_registry_identity_mismatch");
    }
    const workerScope = worker.projectAccessScope;
    if (
      workerScope === undefined ||
      workerScope.projectId !== input.controller.scope.projectId
    ) {
      throw new Error("project_integration_worker_registry_scope_mismatch");
    }
    const [workerRegistryRoot, controllerRegistryRoot, registeredWorkspace] =
      await Promise.all([
        canonicalDirectoryIfExists(workerScope.registryRoot ?? ""),
        canonicalDirectoryIfExists(input.controller.scope.registryRoot ?? ""),
        canonicalDirectoryIfExists(worker.workspacePath),
      ]);
    if (
      workerRegistryRoot !== registryRoot ||
      controllerRegistryRoot !== registryRoot ||
      registeredWorkspace === undefined ||
      registeredWorkspace !== requestedWorkspace
    ) {
      throw new Error("project_integration_worker_registry_ownership_mismatch");
    }
    if (
      !(await pathInsideDeclaredRoots(requestedWorkspace, [
        ...(workerScope.workspaceRoots ?? []),
        ...(workerScope.worktreeRoots ?? []),
      ])) ||
      (workerScope.isolatedWorkspaceRoot !== undefined &&
        (await canonicalDirectoryIfExists(
          workerScope.isolatedWorkspaceRoot,
        )) !== requestedWorkspace)
    ) {
      throw new Error("project_integration_worker_registry_workspace_mismatch");
    }
    const jobRoot = await canonicalDirectoryIfExists(worker.jobRootDir);
    if (jobRoot === undefined) return undefined;
    if (
      basename(jobRoot) !== input.workerJobId ||
      !pathInside(jobStorageRoot, jobRoot)
    ) {
      throw new Error("project_integration_worker_registry_job_root_unowned");
    }
    return jobRoot;
  }

  const legacyJobRoot = await canonicalDirectoryIfExists(
    join(dirname(input.controller.controller.jobRootDir), input.workerJobId),
  );
  if (
    legacyJobRoot !== undefined &&
    (basename(legacyJobRoot) !== input.workerJobId ||
      !pathInside(jobStorageRoot, legacyJobRoot))
  ) {
    throw new Error("project_integration_worker_legacy_job_root_unowned");
  }
  return legacyJobRoot;
}

async function requiredCanonicalDirectory(
  path: string,
  errorCode: string,
): Promise<string> {
  const canonical = await canonicalDirectoryIfExists(path);
  if (canonical === undefined) throw new Error(errorCode);
  return canonical;
}

async function pathInsideDeclaredRoots(
  path: string,
  roots: readonly string[],
): Promise<boolean> {
  for (const rootPath of roots) {
    const root = await canonicalDirectoryIfExists(rootPath);
    if (root !== undefined && pathInside(root, path)) return true;
  }
  return false;
}

type ParsedManifest = {
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly provenance: { readonly baseCommit: string };
  readonly artifacts: {
    readonly patch: ParsedDescriptor;
    readonly summary: ParsedDescriptor;
  };
};

type ParsedDescriptor = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

function parseManifest(bytes: Buffer): ParsedManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("project_integration_handoff_manifest_invalid");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "subscription-runtime-worker-handoff" ||
    typeof value.workerJobId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.jobRootDir !== "string" ||
    typeof value.baseCommit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(value.baseCommit) ||
    !isAbsolute(value.workspacePath) ||
    !isAbsolute(value.jobRootDir) ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.length === 0 ||
    value.changedPaths.length > maxInputChangedPaths ||
    !value.changedPaths.every((path) => typeof path === "string") ||
    !isRecord(value.provenance) ||
    typeof value.provenance.baseCommit !== "string" ||
    value.provenance.generator !== "subscription-runtime" ||
    value.provenance.source !== "terminal-worker-workspace" ||
    !isRecord(value.artifacts)
  ) {
    throw new Error("project_integration_handoff_manifest_invalid");
  }
  const patch = parseDescriptor(value.artifacts.patch);
  const summary = parseDescriptor(value.artifacts.summary);
  return {
    workerJobId: value.workerJobId,
    workspacePath: value.workspacePath,
    jobRootDir: value.jobRootDir,
    baseCommit: value.baseCommit,
    changedPaths: value.changedPaths as readonly string[],
    provenance: { baseCommit: value.provenance.baseCommit },
    artifacts: { patch, summary },
  };
}

function parseDescriptor(value: unknown): ParsedDescriptor {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.sha256)
  ) {
    throw new Error("project_integration_handoff_descriptor_invalid");
  }
  return {
    path: value.path,
    byteLength: value.byteLength,
    sha256: value.sha256.toLowerCase(),
  };
}

function assertDescriptor(
  descriptor: ParsedDescriptor,
  file: { readonly path: string; readonly bytes: Buffer },
  maxBytes: number,
): void {
  if (descriptor.path !== file.path) {
    throw new Error("project_integration_handoff_descriptor_path_mismatch");
  }
  if (
    file.bytes.byteLength !== descriptor.byteLength ||
    file.bytes.byteLength > maxBytes ||
    sha256(file.bytes) !== descriptor.sha256
  ) {
    throw new Error("project_integration_handoff_descriptor_hash_mismatch");
  }
}

async function patchChangedPathsFromGit(
  workspacePath: string,
  patchPath: string,
): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "apply", "--numstat", "-z", patchPath],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    },
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

async function assertExactPatchChangedPaths(input: {
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly expectedChangedPaths: readonly string[];
}): Promise<void> {
  const actual = await patchChangedPathsFromGit(
    input.workspacePath,
    input.patchPath,
  );
  const expected = uniqueSorted(
    input.expectedChangedPaths.map(assertSafeChangedPath),
  );
  if (!sameStrings(actual, expected)) {
    throw new Error("project_integration_handoff_changed_paths_mismatch");
  }
}

async function snapshotValidatedPatch(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly attemptId: string;
  readonly bytes: Buffer;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const controllerRoot = await canonicalDirectoryIfExists(
    input.controller.controller.jobRootDir,
  );
  if (controllerRoot === undefined) {
    throw new Error("project_integration_controller_job_root_missing");
  }
  const snapshotRoot = localProjectIntegrationSnapshotRoot(input.controller);
  const attemptRoot = join(snapshotRoot, input.attemptId);
  await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  const canonicalAttemptRoot = await realpath(attemptRoot);
  if (!pathInside(controllerRoot, canonicalAttemptRoot)) {
    throw new Error("project_integration_snapshot_root_unowned");
  }
  const digest = sha256(input.bytes);
  const snapshotPath = join(canonicalAttemptRoot, `${digest}.patch`);
  await publishExactSnapshot(snapshotPath, input.bytes);
  return { path: snapshotPath, sha256: digest };
}

async function publishExactSnapshot(
  path: string,
  bytes: Buffer,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, bytes, { mode: 0o400, flag: "wx" });
  try {
    try {
      await link(tempPath, path);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readCanonicalRegularFile(path, maxPatchBytes);
      if (!existing.bytes.equals(bytes)) {
        throw new Error("project_integration_snapshot_content_mismatch");
      }
    }
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

async function patchInsideProjectScope(
  controller: ProjectIntegrationMcpController,
  patchPath: string,
): Promise<boolean> {
  const roots = [
    ...(controller.scope.workspaceRoots ?? []),
    ...(controller.scope.worktreeRoots ?? []),
  ];
  for (const rootPath of roots) {
    const root = await canonicalDirectoryIfExists(rootPath);
    if (root !== undefined && pathInside(root, patchPath)) return true;
  }
  return false;
}

async function patchInsideControllerRejectedArchive(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly workerJobId: string;
  readonly patchPath: string;
}): Promise<boolean> {
  const archiveRoot = await canonicalDirectoryIfExists(
    join(input.controller.controller.jobRootDir, "archives"),
  );
  if (archiveRoot === undefined || !pathInside(archiveRoot, input.patchPath)) {
    return false;
  }
  const rel = relative(archiveRoot, input.patchPath);
  const archiveDirectory = dirname(rel);
  return (
    basename(rel) === "tracked.diff" &&
    dirname(archiveDirectory) === "." &&
    archiveDirectory.startsWith(`${input.workerJobId}-rejected-`) &&
    archiveDirectory.length > `${input.workerJobId}-rejected-`.length
  );
}

async function readCanonicalRegularFile(
  path: string,
  maxBytes: number,
): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isFile() || item.size > maxBytes) {
    throw new Error("project_integration_handoff_artifact_unsafe");
  }
  const canonical = await realpath(path);
  const bytes = await readFile(canonical);
  if (bytes.byteLength > maxBytes) {
    throw new Error("project_integration_handoff_artifact_unsafe");
  }
  return { path: canonical, bytes };
}

async function canonicalDirectoryIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || !item.isDirectory()) return undefined;
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertSafeChangedPath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("project_integration_handoff_changed_path_invalid");
  }
  return path;
}

function normalizeChangedPaths(paths: readonly string[]): readonly string[] {
  if (paths.length > maxInputChangedPaths) {
    throw new Error("project_integration_handoff_changed_path_limit_exceeded");
  }
  const normalized = uniqueSorted(paths.map(assertSafeChangedPath));
  if (normalized.length === 0 || normalized.length > maxChangedPaths) {
    throw new Error("project_integration_handoff_changed_path_limit_exceeded");
  }
  return normalized;
}

async function assertValidatedPatchSecretSafe(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
}): Promise<void> {
  try {
    await assertGitPatchBlobsSecretSafe({
      workspacePath: input.workspacePath,
      baseCommit: input.baseCommit.toLowerCase(),
      patchPath: input.patchPath,
      changedPaths: input.changedPaths,
      tempRootDir: join(
        localProjectIntegrationSnapshotRoot(input.controller),
        ".secret-validation",
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("git_patch_secret_like_content:")
    ) {
      throw new Error("project_integration_handoff_secret_like_content");
    }
    throw new Error("project_integration_handoff_blob_validation_failed");
  }
}

async function gitHead(workspacePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
    {
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 15_000,
    },
  );
  const value = stdout.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("project_integration_handoff_base_commit_invalid");
  }
  return value;
}

function assertSafeWorkerJobId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("project_integration_worker_job_id_invalid");
  }
}

function assertSafePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label}_invalid`);
  }
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

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
