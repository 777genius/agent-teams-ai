import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type {
  FileStatLike,
  FileSystemLike,
  ProcessRunnerLike,
  ProcessRunRequestLike,
  ProcessRunResultLike,
} from "./claude-bg-runtime-types";

export class NodeFileSystem implements FileSystemLike {
  readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return readFile(path, encoding);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async stat(path: string): Promise<FileStatLike | null> {
    try {
      const fileStat = await stat(path);
      return {
        isDirectory: fileStat.isDirectory(),
        isFile: fileStat.isFile(),
        modifiedAtMs: fileStat.mtimeMs,
        size: fileStat.size,
      };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await mkdir(path, options);
  }
}

export class NodeProcessRunnerLike implements ProcessRunnerLike {
  run(request: ProcessRunRequestLike): Promise<ProcessRunResultLike> {
    return new Promise<ProcessRunResultLike>((resolve, reject) => {
      const startedAt = performance.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;

      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: toProcessEnv(request.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
      };

      const currentResult = (
        exitCode: number | null,
        signal: NodeJS.Signals | null | undefined,
      ): ProcessRunResultLike => ({
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        exitCode,
        ...(signal === undefined || signal === null ? {} : { signal }),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut,
      });

      child.stdout.on("data", (chunk: Buffer | string | Uint8Array) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string | Uint8Array) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`process_spawn_failed:${error.code ?? "unknown"}`));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(currentResult(exitCode, signal));
      });

      if (request.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, request.timeoutMs);
      }

      child.stdin.end(request.stdin);
    });
  }
}

function toProcessEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
