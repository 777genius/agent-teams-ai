import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
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
  detectSecretLikeContent,
  type RuntimeResultArtifact,
} from "@vioxen/subscription-runtime/worker-core";
import { readGitBlobBatch } from "@vioxen/subscription-runtime/worker-local";
import { assertGitPatchBlobsSecretSafe } from "./git-patch-secret-validator";
import { withLiteralGitPathspecs } from "./git-literal-pathspecs";

const execFileAsync = promisify(execFile);
const maximumHandoffByteLimit = 64 * 1024 * 1024;

export const DEFAULT_HANDOFF_ARTIFACT_LIMITS = {
  maxChangedFiles: 256,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalFileBytes: 16 * 1024 * 1024,
  maxPatchBytes: 16 * 1024 * 1024,
} as const;

export type HandoffArtifactLimits = {
  readonly maxChangedFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxPatchBytes: number;
};

export type CodexGoalHandoffArtifactManifest = {
  readonly schemaVersion: 1;
  readonly kind: "subscription-runtime-worker-handoff";
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly provenance: {
    readonly generator: "subscription-runtime";
    readonly source: "terminal-worker-workspace";
    readonly baseCommit: string;
  };
  readonly artifacts: {
    readonly patch: HandoffArtifactDescriptor;
    readonly summary: HandoffArtifactDescriptor;
  };
};

export type HandoffArtifactDescriptor = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type MaterializedCodexGoalHandoffArtifacts = {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patchPath: string;
  readonly summaryPath: string;
  readonly manifestPath: string;
  readonly manifest: CodexGoalHandoffArtifactManifest;
  readonly artifacts: readonly RuntimeResultArtifact[];
};

export async function materializeCodexGoalHandoffArtifacts(input: {
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
  readonly testHooks?: {
    readonly afterSafetyScan?: (scan: 1 | 2) => Promise<void>;
    readonly afterPatchSnapshot?: (snapshot: 1 | 2) => Promise<void>;
  };
}): Promise<MaterializedCodexGoalHandoffArtifacts | null> {
  assertSafeId(input.workerJobId, "worker_job_id");
  assertSafeId(input.taskId, "task_id");
  const limits = handoffArtifactLimits(input.limits);
  const workspacePath = await canonicalOwnedDirectory(
    input.workspacePath,
    "handoff_workspace",
  );
  await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const jobRootDir = await canonicalOwnedDirectory(
    input.jobRootDir,
    "handoff_job_root",
  );
  const baseCommit = await gitText(workspacePath, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  if (input.expectedBaseCommit && input.expectedBaseCommit !== baseCommit) {
    throw new Error("handoff_base_commit_mismatch");
  }

  const changedPaths = await gitChangedPaths(
    workspacePath,
    baseCommit,
    limits.maxChangedFiles,
  );
  if (changedPaths.length === 0) return null;
  if (changedPaths.length > limits.maxChangedFiles) {
    throw new Error("handoff_changed_file_limit_exceeded");
  }
  await assertSafeChangedFiles({
    workspacePath,
    changedPaths,
    baseCommit,
    limits,
  });
  await input.testHooks?.afterSafetyScan?.(1);
  const patch = await buildDeterministicPatch({
    workspacePath,
    changedPaths,
    baseCommit,
    limits,
  });
  await input.testHooks?.afterPatchSnapshot?.(1);
  await assertGitHeadUnchanged(workspacePath, baseCommit);
  const confirmedChangedPaths = await gitChangedPaths(
    workspacePath,
    baseCommit,
    limits.maxChangedFiles,
  );
  if (!sameStrings(changedPaths, confirmedChangedPaths)) {
    throw new Error("handoff_workspace_changed_during_materialization");
  }
  await assertSafeChangedFiles({
    workspacePath,
    changedPaths: confirmedChangedPaths,
    baseCommit,
    limits,
  });
  await input.testHooks?.afterSafetyScan?.(2);
  const confirmedPatch = await buildDeterministicPatch({
    workspacePath,
    changedPaths: confirmedChangedPaths,
    baseCommit,
    limits,
  });
  await input.testHooks?.afterPatchSnapshot?.(2);
  await assertGitHeadUnchanged(workspacePath, baseCommit);
  if (patch !== confirmedPatch) {
    throw new Error("handoff_workspace_changed_during_materialization");
  }
  const generation = sha256(confirmedPatch);
  const artifactPrefix = `${input.taskId}.${generation}.handoff`;
  const patchPath = join(jobRootDir, `${artifactPrefix}.patch`);
  const summaryPath = join(jobRootDir, `${artifactPrefix}.summary.json`);
  const manifestPath = join(jobRootDir, `${artifactPrefix}.manifest.json`);
  const totalFileBytes = await assertExactPatchSecretSafe({
    workspacePath,
    jobRootDir,
    baseCommit,
    patch: confirmedPatch,
    changedPaths,
    limits,
  });
  await assertGitHeadUnchanged(workspacePath, baseCommit);

  const patchDescriptor = descriptor(patchPath, patch);
  const summary = stableJson({
    schemaVersion: 1,
    kind: "subscription-runtime-worker-handoff-summary",
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    workspacePath,
    baseCommit,
    changedPaths,
    changedFileCount: changedPaths.length,
    totalFileBytes,
    patch: patchDescriptor,
  });
  const summaryDescriptor = descriptor(summaryPath, summary);
  const manifest: CodexGoalHandoffArtifactManifest = {
    schemaVersion: 1,
    kind: "subscription-runtime-worker-handoff",
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    workspacePath,
    jobRootDir,
    baseCommit,
    changedPaths,
    provenance: {
      generator: "subscription-runtime",
      source: "terminal-worker-workspace",
      baseCommit,
    },
    artifacts: {
      patch: patchDescriptor,
      summary: summaryDescriptor,
    },
  };
  const manifestText = stableJson(manifest);

  await publishExactFile(patchPath, patch);
  await publishExactFile(summaryPath, summary);
  await publishExactFile(manifestPath, manifestText);
  return {
    baseCommit,
    changedPaths,
    patchPath,
    summaryPath,
    manifestPath,
    manifest,
    artifacts: [
      runtimeArtifact("patch", patchDescriptor),
      runtimeArtifact("summary", summaryDescriptor),
      runtimeArtifact("manifest", descriptor(manifestPath, manifestText)),
    ],
  };
}

function handoffArtifactLimits(
  overrides: Partial<HandoffArtifactLimits> | undefined,
): HandoffArtifactLimits {
  const limits = { ...DEFAULT_HANDOFF_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = name === "maxChangedFiles"
      ? DEFAULT_HANDOFF_ARTIFACT_LIMITS.maxChangedFiles
      : maximumHandoffByteLimit;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`handoff_limit_invalid:${name}`);
    }
  }
  return limits;
}

async function gitChangedPaths(
  workspacePath: string,
  baseCommit: string,
  maxChangedFiles: number,
): Promise<readonly string[]> {
  const [tracked, untracked] = await Promise.all([
    gitNullPaths(workspacePath, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseCommit,
      "--",
    ]),
    gitNullPaths(workspacePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  if (tracked.length + untracked.length > maxChangedFiles) {
    throw new Error("handoff_changed_file_limit_exceeded");
  }
  return uniqueSorted([...tracked, ...untracked].map(assertSafeRelativePath));
}

async function assertSafeChangedFiles(input: {
  readonly workspacePath: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly limits: HandoffArtifactLimits;
}): Promise<number> {
  let totalBytes = 0;
  const currentBlobs = new Map<string, Buffer>();
  for (const changedPath of input.changedPaths) {
    assertNonSensitivePath(changedPath);
    assertNoRawSecret(Buffer.from(changedPath), changedPath);
    const path = resolve(input.workspacePath, changedPath);
    if (!pathInside(input.workspacePath, path)) {
      throw new Error("handoff_changed_path_escape");
    }
    let currentBytes: Buffer | undefined;
    try {
      const item = await lstat(path);
      if (item.isSymbolicLink()) throw new Error("handoff_symlink_rejected");
      if (!item.isFile()) throw new Error("handoff_special_file_rejected");
      const canonical = await realpath(path);
      if (!pathInside(input.workspacePath, canonical)) {
        throw new Error("handoff_changed_path_escape");
      }
      if (item.size > input.limits.maxFileBytes) {
        throw new Error("handoff_file_byte_limit_exceeded");
      }
      const remainingTotalBytes = input.limits.maxTotalFileBytes - totalBytes;
      if (item.size > remainingTotalBytes) {
        throw new Error("handoff_total_byte_limit_exceeded");
      }
      const handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new Error("handoff_special_file_rejected");
        if (opened.size > input.limits.maxFileBytes) {
          throw new Error("handoff_file_byte_limit_exceeded");
        }
        if (opened.size > remainingTotalBytes) {
          throw new Error("handoff_total_byte_limit_exceeded");
        }
        if (
          opened.dev !== item.dev ||
          opened.ino !== item.ino ||
          opened.size !== item.size ||
          opened.mtimeMs !== item.mtimeMs
        ) {
          throw new Error("handoff_changed_file_unstable");
        }
        currentBytes = await readExactBoundedFile(handle, opened.size);
        const confirmed = await handle.stat();
        if (
          confirmed.size !== opened.size ||
          confirmed.mtimeMs !== opened.mtimeMs
        ) {
          throw new Error("handoff_changed_file_unstable");
        }
      } finally {
        await handle.close();
      }
      currentBlobs.set(changedPath, currentBytes);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (currentBytes !== undefined) {
      totalBytes += currentBytes.byteLength;
      if (totalBytes > input.limits.maxTotalFileBytes) {
        throw new Error("handoff_total_byte_limit_exceeded");
      }
      assertNoRawSecret(currentBytes, changedPath);
    }
  }
  const baseObjects = await gitBaseBlobObjects({
    workspacePath: input.workspacePath,
    baseCommit: input.baseCommit,
    changedPaths: input.changedPaths,
  });
  const objectIds = [...new Set(
    input.changedPaths.flatMap((path) => {
      const objectId = baseObjects.get(path);
      return objectId === undefined ? [] : [objectId];
    }),
  )];
  let objectBlobs: readonly (Buffer | undefined)[] = [];
  try {
    objectBlobs = objectIds.length === 0
      ? []
      : await readGitBlobBatch({
        workspacePath: input.workspacePath,
        objectNames: objectIds,
        maxBlobBytes: input.limits.maxFileBytes,
        maxTotalBytes: input.limits.maxTotalFileBytes - totalBytes,
      });
  } catch (error) {
    throw handoffGitBlobError(error);
  }
  const bytesByObject = new Map<string, Buffer>();
  for (const [index, objectId] of objectIds.entries()) {
    const bytes = objectBlobs[index];
    if (bytes === undefined) throw new Error("handoff_base_blob_missing");
    bytesByObject.set(objectId, bytes);
  }
  for (const changedPath of input.changedPaths) {
    const objectId = baseObjects.get(changedPath);
    const baseBytes = objectId === undefined
      ? undefined
      : bytesByObject.get(objectId);
    if (currentBlobs.get(changedPath) === undefined && baseBytes === undefined) {
      throw new Error("handoff_changed_blob_missing");
    }
    if (baseBytes === undefined) continue;
    totalBytes += baseBytes.byteLength;
    if (totalBytes > input.limits.maxTotalFileBytes) {
      throw new Error("handoff_total_byte_limit_exceeded");
    }
    assertNoRawSecret(baseBytes, changedPath);
  }
  return totalBytes;
}

async function readExactBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  declaredSize: number,
): Promise<Buffer> {
  const contents = Buffer.allocUnsafe(declaredSize);
  let offset = 0;
  while (offset < declaredSize) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      declaredSize - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await handle.read(
    overflow,
    0,
    1,
    offset,
  );
  if (overflowBytes !== 0 || offset !== declaredSize) {
    throw new Error("handoff_changed_file_unstable");
  }
  return contents;
}

async function gitBaseBlobObjects(input: {
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const treeOutput = await gitOutput(input.workspacePath, [
    "ls-tree",
    "-z",
    input.baseCommit,
    "--",
    ...input.changedPaths,
  ], 2 * 1024 * 1024);
  const requested = new Set(input.changedPaths);
  const objects = new Map<string, string>();
  for (const entry of treeOutput.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator).split(" ");
    const listedPath = entry.slice(separator + 1);
    const [mode, type, objectId] = metadata;
    if (
      separator < 0 ||
      !requested.has(listedPath) ||
      objects.has(listedPath) ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId ?? "")
    ) {
      throw new Error("handoff_base_blob_entry_invalid");
    }
    objects.set(listedPath, objectId as string);
  }
  return objects;
}

function handoffGitBlobError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("blob_limit")) {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (
      error.message.includes("total_limit") ||
      error.message.includes("output_limit")
    ) {
      return new Error("handoff_total_byte_limit_exceeded");
    }
  }
  return new Error("handoff_base_blob_unreadable");
}

async function buildDeterministicPatch(input: {
  readonly workspacePath: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly limits: HandoffArtifactLimits;
}): Promise<string> {
  const untracked = new Set(await gitNullPaths(input.workspacePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  const trackedPatch = await gitOutput(input.workspacePath, [
    "diff",
    "--binary",
    "--no-renames",
    input.baseCommit,
    "--",
  ], input.limits.maxPatchBytes);
  const parts = trackedPatch ? [ensureTrailingNewline(trackedPatch)] : [];
  let byteLength = Buffer.byteLength(trackedPatch);
  for (const changedPath of input.changedPaths.filter((path) => untracked.has(path))) {
    const remaining = input.limits.maxPatchBytes - byteLength;
    if (remaining <= 0) throw new Error("handoff_patch_byte_limit_exceeded");
    const item = await gitDiffNoIndex(
      input.workspacePath,
      changedPath,
      remaining,
    );
    const normalized = ensureTrailingNewline(item);
    byteLength += Buffer.byteLength(normalized);
    if (byteLength > input.limits.maxPatchBytes) {
      throw new Error("handoff_patch_byte_limit_exceeded");
    }
    parts.push(normalized);
  }
  const patch = parts.join("");
  if (!patch.trim()) throw new Error("handoff_patch_empty_for_dirty_workspace");
  return patch;
}

async function assertGitHeadUnchanged(
  workspacePath: string,
  expectedHead: string,
): Promise<void> {
  const currentHead = await gitText(workspacePath, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  if (currentHead !== expectedHead) {
    throw new Error("handoff_head_changed_during_materialization");
  }
}

async function assertExactPatchSecretSafe(input: {
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly patch: string;
  readonly changedPaths: readonly string[];
  readonly limits: HandoffArtifactLimits;
}): Promise<number> {
  try {
    return await assertGitPatchBlobsSecretSafe({
      workspacePath: input.workspacePath,
      baseCommit: input.baseCommit,
      patch: input.patch,
      changedPaths: input.changedPaths,
      tempRootDir: input.jobRootDir,
      maxFileBytes: input.limits.maxFileBytes,
      maxTotalFileBytes: input.limits.maxTotalFileBytes,
    });
  } catch (error) {
    throw handoffPatchValidationError(error);
  }
}

function handoffPatchValidationError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.startsWith("git_patch_secret_like_content:")) {
      return new Error(error.message.replace(
        "git_patch_secret_like_content:",
        "handoff_raw_secret_rejected:",
      ));
    }
    if (error.message === "git_patch_secret_file_limit_exceeded") {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_total_limit_exceeded") {
      return new Error("handoff_total_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_changed_paths_mismatch") {
      return new Error("handoff_patch_changed_paths_mismatch");
    }
    if (error.message === "git_patch_secret_changed_blob_missing") {
      return new Error("handoff_changed_blob_missing");
    }
  }
  return new Error("handoff_patch_validation_failed");
}

async function publishExactFile(path: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    try {
      await link(tempPath, path);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const item = await lstat(path);
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new Error("handoff_artifact_existing_path_unsafe");
      }
      if ((await readFile(path, "utf8")) !== content) {
        throw new Error("handoff_artifact_content_mismatch");
      }
    }
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

async function canonicalOwnedDirectory(path: string, label: string): Promise<string> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isDirectory()) {
    throw new Error(`${label}_unsafe`);
  }
  return await realpath(path);
}

function assertSafeRelativePath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("handoff_changed_path_invalid");
  }
  return path;
}

function assertNonSensitivePath(path: string): void {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (
    name === "auth.json" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name === "credentials.json" ||
    lower.includes("/.ssh/") ||
    lower.startsWith(".ssh/")
  ) {
    throw new Error("handoff_sensitive_path_rejected");
  }
}

function assertNoRawSecret(content: Buffer, path: string): void {
  if (detectSecretLikeContent(content, { filePath: path }) !== undefined) {
    throw new Error(`handoff_raw_secret_rejected:${path}`);
  }
}

async function gitNullPaths(
  cwd: string,
  args: readonly string[],
): Promise<readonly string[]> {
  const output = await gitOutput(cwd, args, 2 * 1024 * 1024);
  return output.split("\0").filter(Boolean);
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitOutput(cwd, args, 1024 * 1024)).trim();
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  maxBuffer: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    withLiteralGitPathspecs(["-c", "core.quotepath=false", ...args]),
    {
      cwd,
      encoding: "utf8",
      maxBuffer,
      timeout: 15_000,
    },
  );
  return stdout;
}

async function gitDiffNoIndex(
  cwd: string,
  path: string,
  maxBuffer: number,
): Promise<string> {
  try {
    return await gitOutput(cwd, [
      "diff",
      "--binary",
      "--no-index",
      "--",
      "/dev/null",
      path,
    ], maxBuffer);
  } catch (error) {
    if (isExecErrorWithStdout(error) && error.code === 1) return error.stdout;
    if (isNodeError(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
      throw new Error("handoff_patch_byte_limit_exceeded");
    }
    throw error;
  }
}

function descriptor(path: string, content: string): HandoffArtifactDescriptor {
  return {
    path,
    byteLength: Buffer.byteLength(content),
    sha256: sha256(content),
  };
}

function runtimeArtifact(
  kind: string,
  item: HandoffArtifactDescriptor,
): RuntimeResultArtifact {
  return { kind, ...item };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafeId(value: string, label: string): void {
  if (
    basename(value) !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw new Error(`${label}_invalid`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isExecErrorWithStdout(
  error: unknown,
): error is { readonly code: number; readonly stdout: string } {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === 1 &&
    "stdout" in error && typeof error.stdout === "string";
}
