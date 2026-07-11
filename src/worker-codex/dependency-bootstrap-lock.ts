import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

export type DependencyBootstrapLockInput = {
  readonly cacheRoot: string;
  readonly fingerprint: string;
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly pollIntervalMs?: number;
};

export type DependencyBootstrapLockResult<T> = {
  readonly value: T;
  readonly lockPath: string;
  readonly waitMs: number;
  readonly staleLockRecovered: boolean;
};

export async function withDependencyBootstrapLock<T>(
  input: DependencyBootstrapLockInput,
  operation: () => Promise<T>,
): Promise<DependencyBootstrapLockResult<T>> {
  assertFingerprint(input.fingerprint);
  const lockRoot = join(input.cacheRoot, ".locks");
  const lockPath = join(lockRoot, input.fingerprint);
  const startedAt = Date.now();
  const deadline = startedAt + (input.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let staleLockRecovered = false;
  let acquiredAtMs = startedAt;

  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      acquiredAtMs = Date.now();
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (await removeAbandonedLock(lockPath, staleAfterMs)) {
        staleLockRecovered = true;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("dependency_cache_lock_timeout");
      }
      await delay(pollIntervalMs);
    }
  }

  try {
    return {
      value: await operation(),
      lockPath,
      waitMs: acquiredAtMs - startedAt,
      staleLockRecovered,
    };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeAbandonedLock(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < staleAfterMs) return false;
    const owner = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as { readonly pid?: unknown };
    const pid = typeof owner.pid === "number" ? owner.pid : undefined;
    if (pid !== undefined && processIsAlive(pid)) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      await rm(lockPath, { recursive: true, force: true });
      return true;
    }
    if (error instanceof SyntaxError) {
      await rm(lockPath, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("dependency_cache_fingerprint_invalid");
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
