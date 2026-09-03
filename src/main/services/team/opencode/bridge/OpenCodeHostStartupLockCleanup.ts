import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The claude-multimodel orchestrator serialises OpenCode host startups with
 * lock files under `<data dir>/opencode/host-startup-locks/`. Hosts that are
 * killed - by a force stop, an app shutdown, or a crash - never release their
 * lock, and the orchestrator's next readiness probe waits on every stale lock
 * in turn, so a launch can sit in "spawning" for many minutes after a few of
 * them accumulate. Locks of live hosts are held open by the orchestrator, so
 * an unlink that fails with EBUSY/EPERM is left alone.
 */

const CLAUDE_MULTIMODEL_DATA_DIR_NAME = 'claude-multimodel-nodejs';
const HOST_STARTUP_LOCKS_RELATIVE = ['opencode', 'host-startup-locks'];
const LOCK_ENTRY_PATTERN = /\.lock(?:\.lock)*$/i;

export interface ResolveClaudeMultimodelDataDirOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Mirrors claude-multimodel's env-paths data directory. */
export function resolveClaudeMultimodelDataDir(
  options: ResolveClaudeMultimodelDataDirOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const override = env.CLAUDE_MULTIMODEL_DATA_HOME?.trim();
  if (override && path.isAbsolute(override)) {
    return path.normalize(override);
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, CLAUDE_MULTIMODEL_DATA_DIR_NAME, 'Data');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', CLAUDE_MULTIMODEL_DATA_DIR_NAME);
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
  return path.join(xdgDataHome, CLAUDE_MULTIMODEL_DATA_DIR_NAME);
}

export function resolveOpenCodeHostStartupLocksDir(
  options: ResolveClaudeMultimodelDataDirOptions = {}
): string {
  return path.join(resolveClaudeMultimodelDataDir(options), ...HOST_STARTUP_LOCKS_RELATIVE);
}

export interface PurgeOpenCodeHostStartupLocksOptions extends ResolveClaudeMultimodelDataDirOptions {
  /** Lock directory to purge; resolved from the orchestrator data dir when absent. */
  locksDir?: string;
  /** Only remove entries whose mtime is at least this old (0 = everything). */
  minAgeMs?: number;
  now?: () => number;
}

export interface PurgeOpenCodeHostStartupLocksResult {
  locksDir: string;
  scanned: number;
  removed: number;
  kept: number;
  diagnostics: string[];
}

function isHeldError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export async function purgeStaleOpenCodeHostStartupLocks(
  options: PurgeOpenCodeHostStartupLocksOptions = {}
): Promise<PurgeOpenCodeHostStartupLocksResult> {
  const locksDir = options.locksDir ?? resolveOpenCodeHostStartupLocksDir(options);
  const minAgeMs = Math.max(0, options.minAgeMs ?? 0);
  const nowMs = (options.now ?? Date.now)();
  const result: PurgeOpenCodeHostStartupLocksResult = {
    locksDir,
    scanned: 0,
    removed: 0,
    kept: 0,
    diagnostics: [],
  };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(locksDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.diagnostics.push(`lock dir unreadable: ${String(error)}`);
    }
    return result;
  }

  for (const entry of entries) {
    if (!LOCK_ENTRY_PATTERN.test(entry.name)) {
      continue;
    }
    result.scanned += 1;
    const entryPath = path.join(locksDir, entry.name);
    try {
      if (minAgeMs > 0) {
        const stat = await fs.promises.stat(entryPath);
        if (nowMs - stat.mtimeMs < minAgeMs) {
          result.kept += 1;
          continue;
        }
      }
      if (entry.isDirectory()) {
        await fs.promises.rm(entryPath, { recursive: true, force: false });
      } else {
        await fs.promises.unlink(entryPath);
      }
      result.removed += 1;
    } catch (error) {
      result.kept += 1;
      if (!isHeldError(error) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.diagnostics.push(`${entry.name}: ${String(error)}`);
      }
    }
  }
  return result;
}

/** A host finishes starting within a couple of minutes; older locks guard nothing. */
export const PERIODIC_STALE_LOCK_MIN_AGE_MS = 10 * 60_000;
export const PERIODIC_STALE_LOCK_INTERVAL_MS = 5 * 60_000;

/**
 * Background purge for long sessions. Every orchestrator invocation that
 * touches a host - a launch, a transcript read, a provider status probe -
 * leaves a startup lock behind, and launch readiness stalls once enough of
 * them pile up. Locks older than ten minutes cannot belong to a host that is
 * still starting, so they are removed regardless of which teams are alive.
 *
 * Returns the function that stops the purge; it never throws.
 */
export function startPeriodicOpenCodeHostStartupLockPurge(
  input: PurgeOpenCodeHostStartupLocksOptions & {
    logInfo?: (message: string) => void;
    logWarning?: (message: string) => void;
  } = {}
): () => void {
  const { logInfo, logWarning, ...purgeOptions } = input;
  const run = async (): Promise<void> => {
    try {
      const result = await purgeStaleOpenCodeHostStartupLocks({
        ...purgeOptions,
        minAgeMs: PERIODIC_STALE_LOCK_MIN_AGE_MS,
      });
      if (result.removed > 0) {
        logInfo?.(
          `[OpenCode] periodic purge removed ${result.removed} stale host startup lock(s) (${result.kept} kept)`
        );
      }
      for (const diagnostic of result.diagnostics) {
        logWarning?.(`[OpenCode] periodic lock purge: ${diagnostic}`);
      }
    } catch (error) {
      logWarning?.(
        `[OpenCode] periodic lock purge failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  const timer = setInterval(() => {
    void run();
  }, PERIODIC_STALE_LOCK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
