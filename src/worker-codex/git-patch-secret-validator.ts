import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import {
  detectSecretLikeContent,
  OpaqueSecretDetectionPolicy,
} from "@vioxen/subscription-runtime/worker-core";
import { readGitBlobBatch } from "@vioxen/subscription-runtime/worker-local";
import { withLiteralGitPathspecs } from "./git-literal-pathspecs";

const execFileAsync = promisify(execFile);
const maximumChangedPaths = 256;
const maximumInputChangedPaths = 1024;
const maximumByteLimit = 64 * 1024 * 1024;
const maximumPatchBytes = 16 * 1024 * 1024;
const maximumGitStderrBytes = 64 * 1024;
const gitBase85Alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const gitBase85Values = new Map(
  [...gitBase85Alphabet].map((character, index) => [character, index]),
);

type GitPatchSecretSafetyInput = {
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly tempRootDir: string;
  readonly maxFileBytes?: number;
  readonly maxTotalFileBytes?: number;
  readonly gitBinaryPath?: string;
  readonly opaqueContentPolicy?: OpaqueSecretDetectionPolicy;
  readonly testHooks?: {
    readonly afterPatchPreflight?: () => Promise<void>;
  };
} & (
  | { readonly patchPath: string; readonly patch?: never }
  | { readonly patch: string | Buffer; readonly patchPath?: never }
);

export async function assertGitPatchBlobsSecretSafe(
  input: GitPatchSecretSafetyInput,
): Promise<number> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseCommit)) {
    throw new Error("git_patch_secret_base_invalid");
  }
  const maxFileBytes = exactPositiveLimit(
    input.maxFileBytes ?? 4 * 1024 * 1024,
    "git_patch_secret_file_limit_invalid",
  );
  const maxTotalFileBytes = exactPositiveLimit(
    input.maxTotalFileBytes ?? 16 * 1024 * 1024,
    "git_patch_secret_total_limit_invalid",
  );
  if (input.changedPaths.length > maximumInputChangedPaths) {
    throw new Error("git_patch_secret_changed_path_limit_exceeded");
  }
  const changedPaths = uniqueSorted(input.changedPaths.map(assertSafePath));
  if (changedPaths.length === 0 || changedPaths.length > maximumChangedPaths) {
    throw new Error("git_patch_secret_changed_path_limit_exceeded");
  }
  const patchSnapshot = await readBoundedPatch(input);
  const patchText = decodePatchText(patchSnapshot);
  assertExpandedBinaryPatchLimits(patchText, maxFileBytes, maxTotalFileBytes);
  await input.testHooks?.afterPatchPreflight?.();
  await mkdir(input.tempRootDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(input.tempRootDir, ".secret-scan-"));
  const indexPath = join(tempDir, "index");
  const objectDirectory = join(tempDir, "objects");
  try {
    await mkdir(objectDirectory, { mode: 0o700 });
    const commonDirectoryOutput = await git(
      input,
      ["rev-parse", "--git-common-dir"],
      undefined,
      64 * 1024,
    );
    const commonDirectory = resolve(
      input.workspacePath,
      commonDirectoryOutput.trim(),
    );
    const realObjectDirectory = await realpath(join(commonDirectory, "objects"));
    const env = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjectDirectory,
    };
    await git(input, ["read-tree", input.baseCommit], env, 1024 * 1024);
    await gitWithInput(input, [
      "apply",
      "--cached",
      "--whitespace=nowarn",
      "-",
    ], env, patchSnapshot, 1024 * 1024);
    const appliedPathsOutput = await git(input, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      input.baseCommit,
      "--",
    ], env, 2 * 1024 * 1024);
    const appliedPaths = uniqueSorted(
      appliedPathsOutput.split("\0").filter(Boolean).map(assertSafePath),
    );
    if (
      appliedPaths.length > maximumChangedPaths ||
      !sameStrings(appliedPaths, changedPaths)
    ) {
      throw new Error("git_patch_secret_changed_paths_mismatch");
    }
    const [baseOutput, postOutput] = await Promise.all([
      git(input, [
        "ls-tree",
        "-z",
        input.baseCommit,
        "--",
        ...changedPaths,
      ], env, 2 * 1024 * 1024),
      git(input, [
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...changedPaths,
      ], env, 2 * 1024 * 1024),
    ]);
    const baseObjects = parseTreeEntries(baseOutput, changedPaths);
    const postObjects = parseIndexEntries(postOutput, changedPaths);
    const objectIds = [...new Set(changedPaths.flatMap((path) => [
      baseObjects.get(path),
      postObjects.get(path),
    ].filter((value): value is string => value !== undefined)))];
    let objectBytes: readonly (Buffer | undefined)[];
    try {
      objectBytes = objectIds.length === 0
        ? []
        : await readGitBlobBatch({
          workspacePath: input.workspacePath,
          objectNames: objectIds,
          maxBlobBytes: maxFileBytes,
          maxTotalBytes: maxTotalFileBytes,
          env,
          ...(input.gitBinaryPath === undefined
            ? {}
            : { gitBinaryPath: input.gitBinaryPath }),
        });
    } catch (error) {
      throw mapBlobReadError(error);
    }
    const bytesByObject = new Map<string, Buffer>();
    for (const [index, objectId] of objectIds.entries()) {
      const bytes = objectBytes[index];
      if (bytes === undefined) throw new Error("git_patch_secret_blob_missing");
      bytesByObject.set(objectId, bytes);
    }
    let logicalBytes = 0;
    for (const path of changedPaths) {
      const objectPair = [baseObjects.get(path), postObjects.get(path)];
      if (objectPair.every((value) => value === undefined)) {
        throw new Error("git_patch_secret_changed_blob_missing");
      }
      for (const objectId of objectPair) {
        if (objectId === undefined) continue;
        const bytes = bytesByObject.get(objectId);
        if (bytes === undefined) throw new Error("git_patch_secret_blob_missing");
        logicalBytes += bytes.byteLength;
        if (logicalBytes > maxTotalFileBytes) {
          throw new Error("git_patch_secret_total_limit_exceeded");
        }
        if (detectSecretLikeContent(bytes, {
          filePath: path,
          opaqueContentPolicy: input.opaqueContentPolicy ??
            OpaqueSecretDetectionPolicy.Reject,
        }) !== undefined) {
          throw new Error(`git_patch_secret_like_content:${path}`);
        }
      }
    }
    return logicalBytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("git_patch_secret_")) {
      throw error;
    }
    throw new Error("git_patch_secret_validation_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readBoundedPatch(
  input: Pick<GitPatchSecretSafetyInput, "patch" | "patchPath">,
): Promise<Buffer> {
  if (input.patch !== undefined) return boundedPatchCopy(input.patch);
  const patchPath = input.patchPath;
  if (patchPath === undefined) {
    throw new Error("git_patch_secret_patch_invalid");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      patchPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      opened.size > maximumPatchBytes
    ) {
      throw new Error("git_patch_secret_patch_limit_exceeded");
    }
    const snapshot = await readExactPatch(handle, opened.size);
    const confirmed = await handle.stat();
    if (
      confirmed.dev !== opened.dev ||
      confirmed.ino !== opened.ino ||
      confirmed.size !== opened.size ||
      confirmed.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("git_patch_secret_patch_unstable");
    }
    return snapshot;
  } catch (error) {
    if (isGitPatchSecretError(error)) throw error;
    throw new Error("git_patch_secret_patch_unreadable");
  } finally {
    await handle?.close();
  }
}

function boundedPatchCopy(patch: string | Buffer): Buffer {
  const snapshot = Buffer.isBuffer(patch)
    ? Buffer.from(patch)
    : Buffer.from(patch, "utf8");
  if (snapshot.byteLength > maximumPatchBytes) {
    throw new Error("git_patch_secret_patch_limit_exceeded");
  }
  return snapshot;
}

async function readExactPatch(
  handle: Awaited<ReturnType<typeof open>>,
  declaredSize: number,
): Promise<Buffer> {
  const snapshot = Buffer.allocUnsafe(declaredSize);
  let offset = 0;
  while (offset < declaredSize) {
    const { bytesRead } = await handle.read(
      snapshot,
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
  if (offset !== declaredSize || overflowBytes !== 0) {
    throw new Error("git_patch_secret_patch_unstable");
  }
  return snapshot;
}

function decodePatchText(snapshot: Buffer): string {
  const patch = snapshot.toString("utf8");
  if (!Buffer.from(patch, "utf8").equals(snapshot)) {
    throw new Error("git_patch_secret_patch_invalid");
  }
  return patch;
}

function assertExpandedBinaryPatchLimits(
  patch: string,
  maxFileBytes: number,
  maxTotalFileBytes: number,
): void {
  const lines = patch.split("\n");
  let declaredTotalBytes = 0;
  let reconstructedTotalBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (patchLine(lines, index) !== "GIT binary patch") continue;
    let cursor = index + 1;
    let hunkCount = 0;
    while (cursor < lines.length) {
      while (patchLine(lines, cursor) === "") cursor += 1;
      const declaration = patchLine(lines, cursor);
      if (declaration === undefined || declaration.startsWith("diff --git ")) {
        break;
      }
      const match = /^(literal|delta) ([0-9]+)$/.exec(declaration);
      if (match === null) {
        throw new Error("git_patch_secret_binary_patch_invalid");
      }
      const declaredHunkBytes = Number(match[2]);
      if (
        !Number.isSafeInteger(declaredHunkBytes) ||
        declaredHunkBytes < 0
      ) {
        throw new Error("git_patch_secret_binary_patch_invalid");
      }
      if (declaredHunkBytes > maxFileBytes) {
        throw new Error("git_patch_secret_file_limit_exceeded");
      }
      declaredTotalBytes += declaredHunkBytes;
      if (declaredTotalBytes > maxTotalFileBytes) {
        throw new Error("git_patch_secret_total_limit_exceeded");
      }
      cursor += 1;
      const encodedLines: string[] = [];
      while (cursor < lines.length && patchLine(lines, cursor) !== "") {
        const encodedLine = patchLine(lines, cursor);
        if (encodedLine === undefined || encodedLine.startsWith("diff --git ")) {
          throw new Error("git_patch_secret_binary_patch_invalid");
        }
        encodedLines.push(encodedLine);
        cursor += 1;
      }
      const hunk = inflateGitBinaryHunk(encodedLines, declaredHunkBytes);
      const reconstructedBytes = match[1] === "literal"
        ? declaredHunkBytes
        : deltaTargetSize(hunk, maxFileBytes);
      if (reconstructedBytes > maxFileBytes) {
        throw new Error("git_patch_secret_file_limit_exceeded");
      }
      reconstructedTotalBytes += reconstructedBytes;
      if (reconstructedTotalBytes > maxTotalFileBytes) {
        throw new Error("git_patch_secret_total_limit_exceeded");
      }
      hunkCount += 1;
    }
    if (hunkCount === 0) {
      throw new Error("git_patch_secret_binary_patch_invalid");
    }
    index = cursor - 1;
  }
}

function patchLine(
  lines: readonly string[],
  index: number,
): string | undefined {
  return lines[index]?.replace(/\r$/, "");
}

function inflateGitBinaryHunk(
  encodedLines: readonly string[],
  declaredBytes: number,
): Buffer {
  if (encodedLines.length === 0) {
    throw new Error("git_patch_secret_binary_patch_invalid");
  }
  const compressed = decodeGitBase85Lines(encodedLines);
  try {
    const inflated = inflateSync(compressed, {
      maxOutputLength: declaredBytes + 1,
    });
    if (inflated.byteLength !== declaredBytes) {
      throw new Error("git_patch_secret_binary_patch_invalid");
    }
    return inflated;
  } catch (error) {
    if (isGitPatchSecretError(error)) throw error;
    throw new Error("git_patch_secret_binary_patch_invalid");
  }
}

function decodeGitBase85Lines(lines: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    const lineBytes = gitBase85LineBytes(line[0]);
    const encodedBytes = Math.ceil(lineBytes / 4) * 5;
    if (line.length !== encodedBytes + 1) {
      throw new Error("git_patch_secret_binary_patch_invalid");
    }
    const decoded = Buffer.allocUnsafe(lineBytes);
    let decodedOffset = 0;
    for (let offset = 1; offset < line.length; offset += 5) {
      let value = 0;
      for (let digit = 0; digit < 5; digit += 1) {
        const encoded = line[offset + digit];
        const decodedDigit = encoded === undefined
          ? undefined
          : gitBase85Values.get(encoded);
        if (decodedDigit === undefined) {
          throw new Error("git_patch_secret_binary_patch_invalid");
        }
        value = value * 85 + decodedDigit;
        if (value > 0xffff_ffff) {
          throw new Error("git_patch_secret_binary_patch_invalid");
        }
      }
      const block = Buffer.allocUnsafe(4);
      block.writeUInt32BE(value, 0);
      const copied = Math.min(4, lineBytes - decodedOffset);
      block.copy(decoded, decodedOffset, 0, copied);
      decodedOffset += copied;
    }
    totalBytes += decoded.byteLength;
    if (totalBytes > maximumPatchBytes) {
      throw new Error("git_patch_secret_binary_patch_invalid");
    }
    chunks.push(decoded);
  }
  return Buffer.concat(chunks, totalBytes);
}

function gitBase85LineBytes(prefix: string | undefined): number {
  if (prefix === undefined) {
    throw new Error("git_patch_secret_binary_patch_invalid");
  }
  const code = prefix.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 + 1;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 27;
  throw new Error("git_patch_secret_binary_patch_invalid");
}

function deltaTargetSize(delta: Buffer, maxFileBytes: number): number {
  const source = deltaHeaderSize(delta, 0, maxFileBytes);
  const target = deltaHeaderSize(delta, source.nextOffset, maxFileBytes);
  return target.size;
}

function deltaHeaderSize(
  delta: Buffer,
  startOffset: number,
  maxFileBytes: number,
): { readonly size: number; readonly nextOffset: number } {
  let size = 0;
  let multiplier = 1;
  let offset = startOffset;
  for (let byteCount = 0; byteCount < 10; byteCount += 1) {
    const byte = delta[offset];
    if (byte === undefined) {
      throw new Error("git_patch_secret_binary_patch_invalid");
    }
    const part = (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(part) || size > maxFileBytes - part) {
      throw new Error("git_patch_secret_file_limit_exceeded");
    }
    size += part;
    offset += 1;
    if ((byte & 0x80) === 0) return { size, nextOffset: offset };
    multiplier *= 128;
    if (!Number.isSafeInteger(multiplier)) {
      throw new Error("git_patch_secret_file_limit_exceeded");
    }
  }
  throw new Error("git_patch_secret_binary_patch_invalid");
}

function exactPositiveLimit(value: number, error: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximumByteLimit
  ) {
    throw new Error(error);
  }
  return value;
}

async function git(
  input: {
    readonly workspacePath: string;
    readonly gitBinaryPath?: string;
  },
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  maxBuffer: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    input.gitBinaryPath ?? "git",
    withLiteralGitPathspecs([
      "-c",
      "core.quotepath=false",
      "-C",
      input.workspacePath,
      ...args,
    ]),
    {
      encoding: "utf8",
      env,
      maxBuffer,
      timeout: 30_000,
    },
  );
  return stdout;
}

async function gitWithInput(
  input: {
    readonly workspacePath: string;
    readonly gitBinaryPath?: string;
  },
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: Buffer,
  maxBuffer: number,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      input.gitBinaryPath ?? "git",
      withLiteralGitPathspecs([
        "-c",
        "core.quotepath=false",
        "-C",
        input.workspacePath,
        ...args,
      ]),
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      if (failure !== undefined) return;
      failure = error;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail(new Error("git_patch_secret_git_timeout")),
      30_000,
    );
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (failure !== undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > maxBuffer) {
        fail(new Error("git_patch_secret_git_output_limit_exceeded"));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maximumGitStderrBytes) {
        fail(new Error("git_patch_secret_git_output_limit_exceeded"));
      }
    });
    child.stdin.once("error", () => {
      if (failure === undefined) {
        fail(new Error("git_patch_secret_git_input_failed"));
      }
    });
    child.once("error", () => {
      fail(new Error("git_patch_secret_git_start_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error("git_patch_secret_git_failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
    });
    child.stdin.end(stdin);
  });
}

function parseTreeEntries(
  output: string,
  changedPaths: readonly string[],
): ReadonlyMap<string, string> {
  return parseEntries(output, changedPaths, (metadata) => {
    const [mode, type, objectId] = metadata.split(" ");
    if (
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      !isObjectId(objectId)
    ) {
      throw new Error("git_patch_secret_base_entry_invalid");
    }
    return objectId;
  });
}

function parseIndexEntries(
  output: string,
  changedPaths: readonly string[],
): ReadonlyMap<string, string> {
  return parseEntries(output, changedPaths, (metadata) => {
    const [mode, objectId, stage] = metadata.split(" ");
    if (
      (mode !== "100644" && mode !== "100755") ||
      stage !== "0" ||
      !isObjectId(objectId)
    ) {
      throw new Error("git_patch_secret_post_entry_invalid");
    }
    return objectId;
  });
}

function parseEntries(
  output: string,
  changedPaths: readonly string[],
  objectIdFromMetadata: (metadata: string) => string,
): ReadonlyMap<string, string> {
  const expected = new Set(changedPaths);
  const result = new Map<string, string>();
  for (const entry of output.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const path = entry.slice(separator + 1);
    if (
      separator < 0 ||
      !expected.has(path) ||
      result.has(path)
    ) {
      throw new Error("git_patch_secret_entry_invalid");
    }
    result.set(path, objectIdFromMetadata(entry.slice(0, separator)));
  }
  return result;
}

function assertSafePath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("git_patch_secret_changed_path_invalid");
  }
  return path;
}

function isObjectId(value: string | undefined): value is string {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? "");
}

function mapBlobReadError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("blob_limit")) {
      return new Error("git_patch_secret_file_limit_exceeded");
    }
    if (
      error.message.includes("total_limit") ||
      error.message.includes("output_limit")
    ) {
      return new Error("git_patch_secret_total_limit_exceeded");
    }
  }
  return new Error("git_patch_secret_blob_read_failed");
}

function isGitPatchSecretError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("git_patch_secret_");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
