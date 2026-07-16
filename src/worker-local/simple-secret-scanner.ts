import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  SecretScanStatus,
  detectSecretLikeContent,
  matchesSecretLikeContentPatterns,
  normalizeProjectRelativePath,
  type SecretScannerPort,
  type SecretScanResult,
} from "@vioxen/subscription-runtime/worker-core";
import { readGitBlobBatch } from "./git-blob-batch-reader";

const execFileAsync = promisify(execFile);
const defaultMaxFileBytes = 1024 * 1024;
const defaultMaxTotalFileBytes = 16 * 1024 * 1024;
const defaultMaxChangedFiles = 256;
const maximumInputPaths = 1024;
const maximumByteLimit = 64 * 1024 * 1024;

export type SimpleSecretScannerOptions = {
  readonly maxFileBytes?: number;
  readonly maxTotalFileBytes?: number;
  readonly maxChangedFiles?: number;
  readonly patterns?: readonly RegExp[];
  readonly gitBinaryPath?: string;
};

export class SimpleSecretScanner implements SecretScannerPort {
  constructor(private readonly options: SimpleSecretScannerOptions = {}) {}

  async scanFiles(input: {
    readonly workspacePath: string;
    readonly files: readonly string[];
  }): Promise<SecretScanResult> {
    const workspacePath = await realpath(input.workspacePath);
    const maxFileBytes = scannerLimit(
      this.options.maxFileBytes,
      defaultMaxFileBytes,
      maximumByteLimit,
      "secret_scan_max_file_bytes_invalid",
    );
    const maxTotalFileBytes = scannerLimit(
      this.options.maxTotalFileBytes,
      defaultMaxTotalFileBytes,
      maximumByteLimit,
      "secret_scan_max_total_file_bytes_invalid",
    );
    const maxChangedFiles = scannerLimit(
      this.options.maxChangedFiles,
      defaultMaxChangedFiles,
      defaultMaxChangedFiles,
      "secret_scan_max_changed_files_invalid",
    );
    if (input.files.length > maximumInputPaths) {
      return failed("secret_scan_changed_file_limit_exceeded");
    }
    const files = uniqueSorted(input.files.map(normalizeProjectRelativePath));
    if (files.some((file) =>
      Buffer.byteLength(file) > 4096 || /[\u0000-\u001f\u007f]/.test(file)
    )) {
      return failed("secret_scan_file_path_invalid");
    }
    if (files.length > maxChangedFiles) {
      return failed("secret_scan_changed_file_limit_exceeded");
    }
    const baseCommit = await this.gitText(
      ["rev-parse", "--verify", "HEAD"],
      workspacePath,
    ).catch(() => undefined);
    if (baseCommit === undefined) return failed("secret_scan_base_unreadable");

    const currentBlobs = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const file of files) {
      const result = await readCurrentRegularFile({
        workspacePath,
        file,
        maxFileBytes,
        maxTotalRemainingBytes: maxTotalFileBytes - totalBytes,
      });
      if (result.kind === "missing") continue;
      if (result.kind === "outside") {
        return failed("secret_scan_file_outside_workspace");
      }
      if (result.kind === "too_large") {
        return failed(`secret_scan_file_too_large:${file}`);
      }
      if (result.kind === "total_too_large") {
        return failed("secret_scan_total_file_bytes_exceeded");
      }
      if (result.kind === "unreadable") {
        return failed(`secret_scan_unreadable_file:${file}`);
      }
      if (result.kind !== "read") {
        return failed(`secret_scan_unreadable_file:${file}`);
      }
      totalBytes += result.contents.byteLength;
      if (totalBytes > maxTotalFileBytes) {
        return failed("secret_scan_total_file_bytes_exceeded");
      }
      currentBlobs.set(file, result.contents);
    }

    let baseBlobs: readonly (Buffer | undefined)[];
    try {
      const baseObjects = files.length === 0
        ? new Map<string, string>()
        : await this.gitBaseBlobObjects(workspacePath, baseCommit, files);
      const objectIds = [...new Set(files.flatMap((file) => {
        const objectId = baseObjects.get(file);
        return objectId === undefined ? [] : [objectId];
      }))];
      const objectBlobs = objectIds.length === 0
        ? []
        : await readGitBlobBatch({
          workspacePath,
          objectNames: objectIds,
          maxBlobBytes: maxFileBytes,
          maxTotalBytes: maxTotalFileBytes - totalBytes,
          ...(this.options.gitBinaryPath === undefined
            ? {}
            : { gitBinaryPath: this.options.gitBinaryPath }),
        });
      const bytesByObject = new Map<string, Buffer>();
      for (const [index, objectId] of objectIds.entries()) {
        const bytes = objectBlobs[index];
        if (bytes === undefined) throw new Error("secret_scan_base_blob_missing");
        bytesByObject.set(objectId, bytes);
      }
      baseBlobs = files.map((file) => {
        const objectId = baseObjects.get(file);
        return objectId === undefined ? undefined : bytesByObject.get(objectId);
      });
    } catch (error) {
      return failed(gitBlobScanSafeMessage(error));
    }

    const matches: string[] = [];
    for (const [index, file] of files.entries()) {
      const baseBlob = baseBlobs[index];
      if (baseBlob !== undefined) {
        totalBytes += baseBlob.byteLength;
        if (totalBytes > maxTotalFileBytes) {
          return failed("secret_scan_total_file_bytes_exceeded");
        }
      }
      const blobs = [currentBlobs.get(file), baseBlob].filter(
        (bytes): bytes is Buffer => bytes !== undefined,
      );
      if (blobs.length === 0) {
        return failed(`secret_scan_missing_file_and_base:${file}`);
      }
      if (blobs.some((contents) =>
        detectSecretLikeContent(contents, { filePath: file }) !== undefined ||
        (this.options.patterns !== undefined &&
          matchesSecretLikeContentPatterns(contents, this.options.patterns))
      )) {
        matches.push(file);
      }
    }
    const confirmedBase = await this.gitText(
      ["rev-parse", "--verify", "HEAD"],
      workspacePath,
    ).catch(() => undefined);
    if (confirmedBase !== baseCommit) return failed("secret_scan_base_changed");
    return matches.length > 0
      ? failed(`secret_like_content:${matches.join(",")}`)
      : { status: SecretScanStatus.Passed };
  }

  private async gitText(
    args: readonly string[],
    workspacePath: string,
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      [...args],
      {
        cwd: workspacePath,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
    );
    return stdout.trim();
  }

  private async gitBaseBlobObjects(
    workspacePath: string,
    baseCommit: string,
    files: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const { stdout } = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      ["-c", "core.quotepath=false", "ls-tree", "-z", baseCommit, "--", ...files],
      {
        cwd: workspacePath,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
      },
    );
    const expected = new Set(files);
    const objects = new Map<string, string>();
    for (const entry of stdout.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\t");
      const [mode, type, objectId] = entry.slice(0, separator).split(" ");
      const path = entry.slice(separator + 1);
      if (
        separator < 0 ||
        !expected.has(path) ||
        objects.has(path) ||
        (mode !== "100644" && mode !== "100755") ||
        type !== "blob" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId ?? "")
      ) {
        throw new Error("secret_scan_base_blob_invalid");
      }
      objects.set(path, objectId as string);
    }
    return objects;
  }
}

type CurrentFileRead =
  | { readonly kind: "read"; readonly contents: Buffer }
  | {
    readonly kind:
      | "missing"
      | "outside"
      | "too_large"
      | "total_too_large"
      | "unreadable";
  };

async function readCurrentRegularFile(input: {
  readonly workspacePath: string;
  readonly file: string;
  readonly maxFileBytes: number;
  readonly maxTotalRemainingBytes: number;
}): Promise<CurrentFileRead> {
  const filePath = resolve(input.workspacePath, input.file);
  if (!isPathInside(filePath, input.workspacePath)) return { kind: "outside" };
  try {
    const initial = await lstat(filePath);
    if (!initial.isFile()) return { kind: "unreadable" };
    if (initial.size > input.maxFileBytes) return { kind: "too_large" };
    if (initial.size > input.maxTotalRemainingBytes) {
      return { kind: "total_too_large" };
    }
    const realFilePath = await realpath(filePath);
    if (!isPathInside(realFilePath, input.workspacePath)) return { kind: "outside" };
    const handle = await open(
      realFilePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: "unreadable" };
      if (opened.size > input.maxFileBytes) return { kind: "too_large" };
      if (opened.size > input.maxTotalRemainingBytes) {
        return { kind: "total_too_large" };
      }
      if (
        opened.dev !== initial.dev ||
        opened.ino !== initial.ino ||
        opened.size !== initial.size ||
        opened.mtimeMs !== initial.mtimeMs
      ) {
        return { kind: "unreadable" };
      }
      const contents = await readBoundedFile(handle, opened.size);
      if (contents === undefined) {
        return input.maxFileBytes <= input.maxTotalRemainingBytes
          ? { kind: "too_large" }
          : { kind: "total_too_large" };
      }
      const confirmed = await handle.stat();
      if (
        confirmed.size !== opened.size ||
        confirmed.mtimeMs !== opened.mtimeMs
      ) {
        return { kind: "unreadable" };
      }
      return { kind: "read", contents };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return isNodeErrorCode(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
}

async function readBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  declaredSize: number,
): Promise<Buffer | undefined> {
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
  if (overflowBytes !== 0) return undefined;
  return offset === declaredSize ? contents : contents.subarray(0, offset);
}

function scannerLimit(
  configured: number | undefined,
  fallback: number,
  maximum: number,
  error: string,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(error);
  }
  return value;
}

function gitBlobScanSafeMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("blob_limit")) return "secret_scan_file_too_large";
    if (
      error.message.includes("total_limit") ||
      error.message.includes("output_limit")
    ) {
      return "secret_scan_total_file_bytes_exceeded";
    }
  }
  return "secret_scan_unreadable_base_blobs";
}

function failed(safeMessage: string): SecretScanResult {
  return { status: SecretScanStatus.Failed, safeMessage };
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
