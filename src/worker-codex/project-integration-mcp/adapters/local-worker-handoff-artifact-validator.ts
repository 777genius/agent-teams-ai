import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import type { ProjectIntegrationMcpController } from "../ports/project-integration-mcp-tool-handlers";

const execFileAsync = promisify(execFile);
const maxManifestBytes = 1024 * 1024;
const maxPatchBytes = 16 * 1024 * 1024;

export async function validateLocalWorkerHandoffArtifact(input: {
  readonly controller: ProjectIntegrationMcpController;
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly patchPath: string;
  readonly summaryPath?: string;
  readonly manifestPath?: string;
  readonly manifestSha256?: string;
  readonly baseCommit?: string;
  readonly changedPaths: readonly string[];
}): Promise<{
  readonly baseCommit?: string;
  readonly manifestPath?: string;
  readonly summaryPath?: string;
}> {
  assertSafeWorkerJobId(input.workerJobId);
  const expectedJobRoot = await canonicalDirectoryIfExists(join(
    dirname(input.controller.controller.jobRootDir),
    input.workerJobId,
  ));
  const patchPath = await canonicalRegularFile(input.patchPath, maxPatchBytes);
  if (expectedJobRoot === undefined || !pathInside(expectedJobRoot, patchPath)) {
    if (input.manifestPath || input.manifestSha256) {
      throw new Error("project_integration_handoff_manifest_unowned_patch");
    }
    return {};
  }
  if (!basename(patchPath).endsWith(".handoff.patch")) {
    if (input.manifestPath || input.manifestSha256) {
      throw new Error("project_integration_handoff_manifest_legacy_patch");
    }
    return {};
  }
  if (!input.manifestPath || !input.manifestSha256) {
    throw new Error("project_integration_handoff_manifest_required");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.manifestSha256)) {
    throw new Error("project_integration_handoff_manifest_hash_invalid");
  }
  const manifestPath = await canonicalRegularFile(
    input.manifestPath,
    maxManifestBytes,
  );
  if (!pathInside(expectedJobRoot, manifestPath)) {
    throw new Error("project_integration_handoff_manifest_unowned");
  }
  const manifestBytes = await readFile(manifestPath);
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
  await assertDescriptor(manifest.artifacts.patch, patchPath, maxPatchBytes);
  const summaryPath = await canonicalRegularFile(
    manifest.artifacts.summary.path,
    maxManifestBytes,
  );
  if (!pathInside(expectedJobRoot, summaryPath)) {
    throw new Error("project_integration_handoff_summary_unowned");
  }
  if (input.summaryPath && await realpath(input.summaryPath) !== summaryPath) {
    throw new Error("project_integration_handoff_summary_mismatch");
  }
  await assertDescriptor(
    manifest.artifacts.summary,
    summaryPath,
    maxManifestBytes,
  );
  const manifestChangedPaths = uniqueSorted(
    manifest.changedPaths.map(assertSafeChangedPath),
  );
  const requestedChangedPaths = uniqueSorted(
    input.changedPaths.map(assertSafeChangedPath),
  );
  const patchChangedPaths = await patchChangedPathsFromGit(
    workspacePath,
    patchPath,
  );
  if (
    !sameStrings(manifestChangedPaths, requestedChangedPaths) ||
    !sameStrings(manifestChangedPaths, patchChangedPaths)
  ) {
    throw new Error("project_integration_handoff_changed_paths_mismatch");
  }
  return {
    baseCommit: manifest.baseCommit,
    manifestPath,
    summaryPath,
  };
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

async function assertDescriptor(
  descriptor: ParsedDescriptor,
  expectedPath: string,
  maxBytes: number,
): Promise<void> {
  if (descriptor.path !== expectedPath) {
    throw new Error("project_integration_handoff_descriptor_path_mismatch");
  }
  const bytes = await readFile(expectedPath);
  if (
    bytes.byteLength !== descriptor.byteLength ||
    bytes.byteLength > maxBytes ||
    sha256(bytes) !== descriptor.sha256
  ) {
    throw new Error("project_integration_handoff_descriptor_hash_mismatch");
  }
}

async function patchChangedPathsFromGit(
  workspacePath: string,
  patchPath: string,
): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    workspacePath,
    "apply",
    "--numstat",
    "-z",
    patchPath,
  ], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
  return uniqueSorted(stdout.split("\0").filter(Boolean).map((record) => {
    const fields = record.split("\t");
    return assertSafeChangedPath(fields.slice(2).join("\t"));
  }));
}

async function canonicalRegularFile(path: string, maxBytes: number): Promise<string> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isFile() || item.size > maxBytes) {
    throw new Error("project_integration_handoff_artifact_unsafe");
  }
  return await realpath(path);
}

async function canonicalDirectoryIfExists(path: string): Promise<string | undefined> {
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
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("project_integration_handoff_changed_path_invalid");
  }
  return path;
}

function assertSafeWorkerJobId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("project_integration_worker_job_id_invalid");
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
