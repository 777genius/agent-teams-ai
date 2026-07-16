import { spawn } from "node:child_process";

const maxBatchObjects = 512;
const maxObjectNameBytes = 8 * 1024;
const maxBatchBlobBytes = 64 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;
const maxResponseHeaderBytes = maxObjectNameBytes + 128;

export type GitBlobBatchOptions = {
  readonly workspacePath: string;
  readonly objectNames: readonly string[];
  readonly maxBlobBytes: number;
  readonly maxTotalBytes: number;
  readonly gitBinaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

/**
 * Reads a bounded set of Git blobs through one `cat-file --batch` subprocess.
 * Results stay aligned with objectNames; missing objects are represented by
 * undefined. Callers remain responsible for deciding whether absence is valid.
 */
export async function readGitBlobBatch(
  input: GitBlobBatchOptions,
): Promise<readonly (Buffer | undefined)[]> {
  assertBatchLimit(input.maxBlobBytes, false, "git_blob_batch_file_limit_invalid");
  assertBatchLimit(input.maxTotalBytes, true, "git_blob_batch_total_limit_invalid");
  if (
    input.objectNames.length === 0 ||
    input.objectNames.length > maxBatchObjects
  ) {
    throw new Error("git_blob_batch_object_limit_exceeded");
  }
  for (const objectName of input.objectNames) {
    const byteLength = Buffer.byteLength(objectName);
    if (
      byteLength === 0 ||
      byteLength > maxObjectNameBytes ||
      /[\r\n\0]/.test(objectName)
    ) {
      throw new Error("git_blob_batch_object_name_invalid");
    }
  }
  return await runGitBlobBatch({
    ...input,
    request: `${input.objectNames.join("\n")}\n`,
  });
}

function assertBatchLimit(
  value: number,
  allowZero: boolean,
  error: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maxBatchBlobBytes
  ) {
    throw new Error(error);
  }
}

async function runGitBlobBatch(
  input: GitBlobBatchOptions & { readonly request: string },
): Promise<readonly (Buffer | undefined)[]> {
  return await new Promise<readonly (Buffer | undefined)[]>((resolve, reject) => {
    const child = spawn(
      input.gitBinaryPath ?? "git",
      ["cat-file", "--batch"],
      {
        cwd: input.workspacePath,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const parser = new GitBlobBatchStreamParser({
      objectNames: input.objectNames,
      maxBlobBytes: input.maxBlobBytes,
      maxTotalBytes: input.maxTotalBytes,
    });
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
      () => fail(new Error("git_blob_batch_timeout")),
      input.timeoutMs ?? 15_000,
    );
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (failure !== undefined) return;
      try {
        parser.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        fail(asError(error, "git_blob_batch_output_invalid"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes) {
        fail(new Error("git_blob_batch_stderr_limit_exceeded"));
      }
    });
    child.stdin.on("error", () => {
      if (failure === undefined) fail(new Error("git_blob_batch_input_failed"));
    });
    child.once("error", () => {
      fail(new Error("git_blob_batch_start_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error("git_blob_batch_failed"));
        return;
      }
      try {
        resolve(parser.finish());
      } catch (error) {
        reject(asError(error, "git_blob_batch_output_invalid"));
      }
    });
    child.stdin.end(input.request);
  });
}

type ParserState =
  | { readonly kind: "header" }
  | {
    readonly kind: "blob";
    readonly size: number;
    readonly buffer: Buffer;
    bytes: number;
  }
  | { readonly kind: "delimiter"; readonly blob: Buffer };

class GitBlobBatchStreamParser {
  private readonly results: Array<Buffer | undefined> = [];
  private state: ParserState = { kind: "header" };
  private headerChunks: Buffer[] = [];
  private headerBytes = 0;
  private declaredTotalBytes = 0;

  constructor(private readonly limits: {
    readonly objectNames: readonly string[];
    readonly maxBlobBytes: number;
    readonly maxTotalBytes: number;
  }) {}

  write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.results.length === this.limits.objectNames.length) {
        throw new Error("git_blob_batch_output_invalid");
      }
      if (this.state.kind === "header") {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          this.appendHeader(chunk.subarray(offset));
          return;
        }
        this.appendHeader(chunk.subarray(offset, newline));
        offset = newline + 1;
        this.acceptHeader();
        continue;
      }
      if (this.state.kind === "blob") {
        const remaining = this.state.size - this.state.bytes;
        const consumed = Math.min(remaining, chunk.byteLength - offset);
        if (consumed > 0) {
          chunk.copy(
            this.state.buffer,
            this.state.bytes,
            offset,
            offset + consumed,
          );
          this.state.bytes += consumed;
          offset += consumed;
        }
        if (this.state.bytes === this.state.size) {
          this.state = { kind: "delimiter", blob: this.state.buffer };
        }
        continue;
      }
      if (chunk[offset] !== 0x0a) {
        throw new Error("git_blob_batch_output_invalid");
      }
      this.results.push(this.state.blob);
      this.state = { kind: "header" };
      offset += 1;
    }
  }

  finish(): readonly (Buffer | undefined)[] {
    if (
      this.results.length !== this.limits.objectNames.length ||
      this.state.kind !== "header" ||
      this.headerBytes !== 0
    ) {
      throw new Error("git_blob_batch_output_invalid");
    }
    return this.results;
  }

  private appendHeader(bytes: Buffer): void {
    this.headerBytes += bytes.byteLength;
    if (this.headerBytes > maxResponseHeaderBytes) {
      throw new Error("git_blob_batch_output_limit_exceeded");
    }
    if (bytes.byteLength > 0) this.headerChunks.push(Buffer.from(bytes));
  }

  private acceptHeader(): void {
    const header = Buffer.concat(this.headerChunks, this.headerBytes).toString("utf8");
    this.headerChunks = [];
    this.headerBytes = 0;
    const expectedObjectName = this.limits.objectNames[this.results.length];
    if (expectedObjectName === undefined) {
      throw new Error("git_blob_batch_output_invalid");
    }
    if (header === `${expectedObjectName} missing`) {
      this.results.push(undefined);
      return;
    }
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(header);
    if (match === null || match[1] !== expectedObjectName) {
      throw new Error("git_blob_batch_output_invalid");
    }
    const size = Number(match[2]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > this.limits.maxBlobBytes
    ) {
      throw new Error("git_blob_batch_blob_limit_exceeded");
    }
    this.declaredTotalBytes += size;
    if (this.declaredTotalBytes > this.limits.maxTotalBytes) {
      throw new Error("git_blob_batch_total_limit_exceeded");
    }
    this.state = {
      kind: "blob",
      size,
      buffer: Buffer.allocUnsafe(size),
      bytes: 0,
    };
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
