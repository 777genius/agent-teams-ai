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
  /**
   * Removes one lock entry; defaults to unlinking it. This is the only step
   * here that touches the disk destructively, and it is a port because the
   * outcome that matters most - the OS refusing removal because a live host
   * still holds the lock open - is a sharing violation no test can provoke the
   * same way on every platform.
   */
  removeLockEntry?: (entry: { path: string; isDirectory: boolean }) => Promise<void>;
}

export interface PurgeOpenCodeHostStartupLocksResult {
  locksDir: string;
  scanned: number;
  removed: number;
  kept: number;
  diagnostics: string[];
}

async function unlinkLockEntry(entry: { path: string; isDirectory: boolean }): Promise<void> {
  if (entry.isDirectory) {
    await fs.promises.rm(entry.path, { recursive: true, force: false });
    return;
  }
  await fs.promises.unlink(entry.path);
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
  const removeLockEntry = options.removeLockEntry ?? unlinkLockEntry;
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
      await removeLockEntry({ path: entryPath, isDirectory: entry.isDirectory() });
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

/**
 * Locks of a host that is genuinely starting are at most a few seconds old, so
 * anything older than this immediately before a launch belongs to a host that
 * is already gone.
 */
export const PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS = 120_000;

/**
 * Startup floor, applied once the reap of managed hosts has run. Half a minute
 * is safe only where the OS refuses to unlink a lock a live host still holds
 * open: that refusal, and not the age, is what keeps an active startup's lock.
 */
export const STARTUP_STALE_LOCK_MIN_AGE_MS = 30_000;

/**
 * The startup floor this platform may use. Windows refuses to unlink a file a
 * live host holds open, so a lock that survives the purge there proves its
 * owner is alive. POSIX unlinks an open file happily - the holder keeps its
 * descriptor and only the directory entry goes - so an orchestrator startup
 * that is still running loses its lock and the serialisation with it, and a
 * later launch proceeds concurrently. These locks belong to the
 * claude-multimodel orchestrator and carry no owner this app may read, so
 * where the refusal is missing the age is the whole guard: it has to be the
 * age past which a host cannot still be starting, which is the pre-launch
 * floor the same module already trusts at a far more exposed moment.
 */
export function resolveStartupStaleLockMinAgeMs(
  platform: NodeJS.Platform = process.platform
): number {
  return platform === 'win32' ? STARTUP_STALE_LOCK_MIN_AGE_MS : PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS;
}

/**
 * Pre-launch purge. A clean (non-escalated) stop leaves the stopped hosts'
 * startup locks behind, and the orchestrator serialises the next launch behind
 * every one of them in turn. With no other team alive there is nothing left to
 * protect, so every lock past the pre-launch threshold goes.
 *
 * Returns `null` when it declined to purge or could not: this runs on the way
 * into a launch and must never be the reason one fails, so it swallows its own
 * failure rather than propagating it.
 */
export async function purgeStaleOpenCodeHostStartupLocksBeforeLaunch(
  input: Omit<PurgeOpenCodeHostStartupLocksOptions, 'minAgeMs'> & {
    teamName: string;
    aliveTeams: readonly string[];
    logRemoved?: (message: string) => void;
    logWarning?: (message: string) => void;
  }
): Promise<PurgeOpenCodeHostStartupLocksResult | null> {
  const { teamName, aliveTeams, logRemoved, logWarning, ...purgeOptions } = input;
  // A lock the team being launched left behind is fair game; one belonging to
  // a team that is still running is not, and nothing here can tell them apart.
  if (aliveTeams.some((alive) => alive !== teamName)) {
    return null;
  }
  try {
    const result = await purgeStaleOpenCodeHostStartupLocks({
      ...purgeOptions,
      minAgeMs: PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS,
    });
    if (result.removed > 0) {
      logRemoved?.(
        `opencode_startup_locks_purged team=${teamName} phase=pre_launch removed=${result.removed} kept=${result.kept}`
      );
    }
    for (const diagnostic of result.diagnostics) {
      logWarning?.(`[${teamName}] Pre-launch OpenCode host startup lock purge: ${diagnostic}`);
    }
    return result;
  } catch (error) {
    logWarning?.(
      `[${teamName}] Pre-launch OpenCode host startup lock purge failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
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
