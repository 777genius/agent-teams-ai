import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, win32 } from "node:path";

export type ClaudeLogicalThreadState = {
  readonly threadId: string;
  readonly cwd: string;
  readonly generation: number;
  readonly latestSessionId?: string;
  readonly latestBundleId?: string;
  readonly latestProviderInstanceId?: string;
  readonly latestWorkerId?: string;
  readonly updatedAt: string;
};

export interface ClaudeLogicalThreadStore {
  read(threadId: string): Promise<ClaudeLogicalThreadState | null>;
  compareAndSwap(input: {
    readonly threadId: string;
    readonly expectedGeneration: number;
    readonly next: Omit<ClaudeLogicalThreadState, "generation">;
  }): Promise<ClaudeLogicalThreadState>;
}

export type ClaudeTranscriptBundle = {
  readonly bundleId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sourceConfigDir: string;
  readonly files: readonly string[];
  readonly capturedAt: string;
};

export interface ClaudeTranscriptBundleStore {
  capture(input: {
    readonly sourceConfigDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }): Promise<ClaudeTranscriptBundle>;
  materialize(input: {
    readonly bundleId: string;
    readonly targetConfigDir: string;
  }): Promise<ClaudeTranscriptBundle>;
}

export class ClaudeLogicalThreadConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super("claude_logical_thread_generation_conflict");
    this.name = "ClaudeLogicalThreadConflictError";
  }
}

export class FileClaudeLogicalThreadStore
  implements ClaudeLogicalThreadStore
{
  private readonly threadsDir: string;
  private readonly locksDir: string;

  constructor(private readonly rootDir: string) {
    this.threadsDir = join(rootDir, "threads");
    this.locksDir = join(rootDir, "locks");
  }

  async read(threadId: string): Promise<ClaudeLogicalThreadState | null> {
    try {
      return parseThreadState(await readFile(this.threadPath(threadId), "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async compareAndSwap(input: {
    readonly threadId: string;
    readonly expectedGeneration: number;
    readonly next: Omit<ClaudeLogicalThreadState, "generation">;
  }): Promise<ClaudeLogicalThreadState> {
    return this.withThreadLock(input.threadId, async () => {
      const current = await this.read(input.threadId);
      const actualGeneration = current?.generation ?? 0;
      if (actualGeneration !== input.expectedGeneration) {
        throw new ClaudeLogicalThreadConflictError(
          input.threadId,
          input.expectedGeneration,
          actualGeneration,
        );
      }

      const next: ClaudeLogicalThreadState = {
        ...input.next,
        generation: actualGeneration + 1,
      };
      await mkdir(this.threadsDir, { recursive: true, mode: 0o700 });
      const path = this.threadPath(input.threadId);
      const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tempPath, path);
      return next;
    });
  }

  private async withThreadLock<T>(
    threadId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.locksDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.locksDir, `${hashText(threadId)}.lock`);
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error("claude_logical_thread_lock_timeout");
        }
        await delay(25);
      }
    }

    try {
      return await action();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private threadPath(threadId: string): string {
    return join(this.threadsDir, `${hashText(threadId)}.json`);
  }
}

export class FileClaudeTranscriptBundleStore
  implements ClaudeTranscriptBundleStore
{
  private readonly bundlesDir: string;

  constructor(private readonly rootDir: string) {
    this.bundlesDir = join(rootDir, "bundles");
  }

  async capture(input: {
    readonly sourceConfigDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }): Promise<ClaudeTranscriptBundle> {
    const sourceConfigDir = await realpath(input.sourceConfigDir);
    const transcriptPath = await findTranscriptPath(
      sourceConfigDir,
      input.sessionId,
    );
    if (!transcriptPath) {
      throw new Error("claude_transcript_not_found");
    }

    const projectDir = dirname(transcriptPath);
    const files = await transcriptBundleFiles(projectDir, input.sessionId);
    const bundleId = `bundle-${hashText(
      `${input.cwd}:${input.sessionId}:${Date.now()}:${randomUUID()}`,
    ).slice(0, 24)}`;
    const bundleDir = this.bundleDir(bundleId);
    const filesDir = join(bundleDir, "files");

    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    const relativeFiles: string[] = [];
    for (const filePath of files) {
      const relativePath = requireSafeRelativePath(
        relative(sourceConfigDir, filePath),
      );
      relativeFiles.push(relativePath);
      const targetPath = join(filesDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(filePath, targetPath, { force: true });
    }

    const bundle: ClaudeTranscriptBundle = {
      bundleId,
      cwd: await realpath(input.cwd),
      sessionId: input.sessionId,
      sourceConfigDir,
      files: relativeFiles.sort(),
      capturedAt: new Date().toISOString(),
    };
    await writeFile(
      join(bundleDir, "manifest.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      { mode: 0o600 },
    );
    return bundle;
  }

  async materialize(input: {
    readonly bundleId: string;
    readonly targetConfigDir: string;
  }): Promise<ClaudeTranscriptBundle> {
    const bundleDir = this.bundleDir(input.bundleId);
    const bundle = parseBundle(
      await readFile(join(bundleDir, "manifest.json"), "utf8"),
    );
    const targetConfigDir = await ensureRealDirectory(input.targetConfigDir);
    const filesDir = join(bundleDir, "files");

    for (const file of bundle.files) {
      const relativePath = requireSafeRelativePath(file);
      const sourcePath = join(filesDir, relativePath);
      const sourceStats = await lstat(sourcePath);
      if (!sourceStats.isFile()) {
        throw new Error("claude_transcript_bundle_file_invalid");
      }
      const targetPath = join(targetConfigDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(sourcePath, targetPath, { force: true });
    }

    return bundle;
  }

  private bundleDir(bundleId: string): string {
    return join(this.bundlesDir, requireSafeId(bundleId));
  }
}

async function findTranscriptPath(
  configDir: string,
  sessionId: string,
): Promise<string | null> {
  const projectsDir = join(configDir, "projects");
  try {
    return await findFile(projectsDir, `${sessionId}.jsonl`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function findFile(dir: string, fileName: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, fileName);
      if (found) return found;
    }
  }
  return null;
}

async function transcriptBundleFiles(
  projectDir: string,
  sessionId: string,
): Promise<readonly string[]> {
  const main = join(projectDir, `${sessionId}.jsonl`);
  const files = new Set<string>([main]);
  const sessionSidecarDir = join(projectDir, sessionId);
  if (await pathExists(sessionSidecarDir)) {
    for (const file of await listFiles(sessionSidecarDir)) files.add(file);
  }
  const subagentsDir = join(projectDir, "subagents");
  if (await pathExists(subagentsDir)) {
    for (const file of await listFiles(subagentsDir)) files.add(file);
  }
  return [...files].sort();
}

async function listFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push(path);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

function parseThreadState(raw: string): ClaudeLogicalThreadState {
  const value = JSON.parse(raw) as ClaudeLogicalThreadState;
  if (!value.threadId || !Number.isInteger(value.generation)) {
    throw new Error("claude_logical_thread_state_invalid");
  }
  return value;
}

function parseBundle(raw: string): ClaudeTranscriptBundle {
  const value = JSON.parse(raw) as ClaudeTranscriptBundle;
  if (!value.bundleId || !value.sessionId || !Array.isArray(value.files)) {
    throw new Error("claude_transcript_bundle_invalid");
  }
  return value;
}

function requireSafeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("claude_safe_id_required");
  }
  return value;
}

function requireSafeRelativePath(value: string): string {
  const normalizedInput = value.replace(/\\/g, "/");
  const normalizedPath = posix.normalize(normalizedInput);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedInput.split("/").includes("..")
  ) {
    throw new Error("claude_safe_relative_path_required");
  }
  return normalizedPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
