import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  StrictResultRecorder,
  type RuntimePatchPreserverPort,
  type RuntimeResultArtifact,
  type RuntimeResultEnvelope,
  type RuntimeResultWriterPort,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);
const defaultGitCommandTimeoutMs = 10_000;

export class AtomicJsonRuntimeResultWriter implements RuntimeResultWriterPort {
  async writeResult(input: {
    readonly path: string;
    readonly result: RuntimeResultEnvelope;
  }): Promise<void> {
    await writeAtomicJson(input.path, input.result);
  }
}

export function createCodexGoalResultRecorder(input: {
  readonly outputPath: string;
  readonly clock?: { now(): Date };
}): StrictResultRecorder {
  return new StrictResultRecorder({
    outputPath: input.outputPath,
    writer: new AtomicJsonRuntimeResultWriter(),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

export class GitPatchPreserver implements RuntimePatchPreserverPort {
  constructor(private readonly options: {
    readonly gitBinaryPath?: string;
  } = {}) {}

  async preserve(input: {
    readonly workspacePath: string;
    readonly outputPath: string;
  }): Promise<RuntimeResultArtifact | null> {
    const gitBinaryPath = this.options.gitBinaryPath ?? "git";
    const hasHead = await gitHasHead({
      gitBinaryPath,
      workspacePath: input.workspacePath,
    });
    const trackedPatch = await gitDiff({
      gitBinaryPath,
      workspacePath: input.workspacePath,
      args: hasHead
        ? ["diff", "--binary", "HEAD", "--"]
        : ["diff", "--binary", "--"],
    });
    const untrackedPatch = await gitUntrackedPatch({
      gitBinaryPath,
      workspacePath: input.workspacePath,
    });
    const patch = [trackedPatch, untrackedPatch]
      .map((value) => value.trimEnd())
      .filter(Boolean)
      .join("\n");
    if (!patch.trim()) return null;
    await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(input.outputPath, `${patch}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const item = await stat(input.outputPath);
    return {
      kind: "patch",
      path: input.outputPath,
      byteLength: item.size,
    };
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${randomUUID()}-${basenameForTemp(path)}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function gitHasHead(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<boolean> {
  try {
    await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD",
    ], { timeout: defaultGitCommandTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function gitDiff(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
  readonly args: readonly string[];
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      ...input.args,
    ], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: defaultGitCommandTimeoutMs,
    });
    return stdout;
  } catch (error) {
    if (isExecErrorWithStdout(error)) return error.stdout;
    throw error;
  }
}

async function gitUntrackedPatch(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<string> {
  const { stdout } = await execFileAsync(input.gitBinaryPath, [
    "-C",
    input.workspacePath,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: defaultGitCommandTimeoutMs,
  });
  const paths = stdout.split("\0").filter(Boolean);
  const patches = await Promise.all(paths.map((path) =>
    gitDiff({
      gitBinaryPath: input.gitBinaryPath,
      workspacePath: input.workspacePath,
      args: ["diff", "--binary", "--no-index", "--", "/dev/null", path],
    })
  ));
  return patches.join("\n");
}

function basenameForTemp(path: string): string {
  return path.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9_.-]/g, "_") ||
    "runtime-result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecErrorWithStdout(error: unknown): error is { readonly stdout: string } {
  return isRecord(error) && typeof error.stdout === "string";
}
