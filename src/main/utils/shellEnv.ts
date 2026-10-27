/**
 * Interactive shell environment resolver.
 *
 * Resolves the user's interactive shell environment (PATH, etc.) by spawning
 * a login/interactive shell and reading its exported variables. The result is
 * cached for the lifetime of the process.
 *
 * Extracted from TeamProvisioningService for reuse by ScheduledTaskExecutor
 * and any other service that needs the user's shell environment.
 */

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { accessSync, constants as fsConstants } from 'fs';

const logger = createLogger('Utils:shellEnv');

/**
 * Default login-shell candidates, most preferred first.
 *
 * macOS keeps the platform default `/bin/zsh` and falls back to its older
 * default when zsh was removed. Linux users may rely on zsh even when
 * `$SHELL` is unset (for example when the account's login shell is zsh but
 * the variable was not propagated), and variables exported by `.zshrc` are
 * only visible when zsh itself is probed. Therefore `/bin/zsh` is probed
 * before the generic Bash fallbacks on every POSIX platform, while Bash and
 * `/bin/sh` remain available for containers and images without zsh. A
 * configured `$SHELL` is always honoured as-is; when that configured shell
 * is missing the normal resolution failure path reports it rather than
 * silently probing a different shell. No candidate is assumed to exist
 * without an executable probe.
 */
export function defaultShellCandidates(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'darwin') return ['/bin/zsh', '/bin/bash', '/bin/sh'];
  return ['/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
}

/**
 * Check whether a candidate shell path exists and is executable.
 */
function probeExecutableShell(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the shell path used to read the exported interactive environment.
 *
 * A configured `$SHELL` wins verbatim (the repository never assumes that a
 * configured shell exists; its absence surfaces through the resolver's normal
 * failure diagnostics). Without one, the first installed platform candidate is
 * used, with `/bin/sh` as the guaranteed last resort so a bare container gets
 * a working probe instead of a misleading `<platform-default> ENOENT`. The
 * filesystem probe is injectable so tests can express every platform.
 */
export function resolveDefaultLoginShellPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    probe?: (candidatePath: string) => boolean;
  } = {}
): string {
  const configured = (options.env ?? process.env).SHELL?.trim();
  if (configured) return configured;
  const probe = options.probe ?? probeExecutableShell;
  const candidates = defaultShellCandidates(options.platform ?? process.platform);
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  return '/bin/sh';
}

const SHELL_ENV_TIMEOUT_MS = 12_000;
const SHELL_ENV_BEST_EFFORT_TIMEOUT_MS = 5_000;
const SHELL_ENV_FAILURE_COOLDOWN_MS = 60_000;

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;
let shellEnvResolvePromise: Promise<NodeJS.ProcessEnv> | null = null;
let shellEnvFailureCooldownUntil = 0;
let lastShellEnvFailureMessage: string | null = null;

export interface ShellEnvResolveProgress {
  phase: string;
  message: string;
  source?: string;
}

export interface ShellEnvResolveOptions {
  onProgress?: (progress: ShellEnvResolveProgress) => void;
  /**
   * Stable diagnostic label for the caller that initiated the shell probe.
   * Keep this to a short feature/service id, not a filesystem path.
   */
  source?: string;
}

export interface ShellEnvBestEffortResolveOptions extends ShellEnvResolveOptions {
  /**
   * Max time to wait on the critical path before returning fallbackEnv.
   * By default, the full shell resolve continues in the background and caches
   * on success. Set background=false for hot paths that only want cached env
   * or an immediate fallback.
   */
  timeoutMs?: number;
  /**
   * Whether a slow shell probe should continue in the background after the
   * caller falls back. Disable this for startup/status hot paths where a
   * delayed hard timeout would only create log noise and process pressure.
   */
  background?: boolean;
  /**
   * Returned when shell env is not ready quickly enough. This is intentionally
   * not cached as a real shell env.
   */
  fallbackEnv?: NodeJS.ProcessEnv;
}

function emitProgress(
  options: ShellEnvResolveOptions | undefined,
  phase: string,
  message: string
): void {
  const source = normalizeShellEnvSource(options?.source);
  options?.onProgress?.(source ? { phase, message, source } : { phase, message });
}

function normalizeShellEnvSource(source: string | undefined): string | null {
  const trimmed = source?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

function formatShellEnvSource(options: ShellEnvResolveOptions | undefined): string {
  const source = normalizeShellEnvSource(options?.source);
  return source ? ` source=${source}` : '';
}

function rememberShellEnvFailure(message: string): void {
  lastShellEnvFailureMessage = message;
  shellEnvFailureCooldownUntil = Date.now() + SHELL_ENV_FAILURE_COOLDOWN_MS;
}

function clearShellEnvFailure(): void {
  lastShellEnvFailureMessage = null;
  shellEnvFailureCooldownUntil = 0;
}

/**
 * Parse a NUL-separated `env -0` dump into a process-env record.
 */
function parseNullSeparatedEnv(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = content.split('\0');
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Spawn the given shell with args and resolve its exported environment.
 */
async function readShellEnv(shellPath: string, mode: '-lic' | '-ic'): Promise<NodeJS.ProcessEnv> {
  const nonce = `AGENT_TEAMS_SHELL_ENV_${randomUUID()}`;
  const startMarker = `\0${nonce}_START\0`;
  const endMarker = `\0${nonce}_END\0`;
  // Only a successful env command prints the matching end marker. Startup and
  // logout output outside the frame cannot masquerade as exported variables.
  // Quoted printable constants and && work in sh, bash, zsh and modern fish.
  const command = `printf '\\0%s\\0' '${nonce}_START' && env -0 && printf '\\0%s\\0' '${nonce}_END'`;
  const envDump = await new Promise<string>((resolve, reject) => {
    const child = spawn(shellPath, [mode, command], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      // SIGKILL fallback if SIGTERM is ignored (e.g., shell stuck on .zshrc)
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 3000);
      if (!settled) {
        settled = true;
        reject(new Error('shell env resolve timeout'));
      }
    }, SHELL_ENV_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!settled) {
        settled = true;
        const content = Buffer.concat(chunks).toString('utf8');
        const startIndex = content.indexOf(startMarker);
        const dumpStart = startIndex + startMarker.length;
        const endIndex = startIndex < 0 ? -1 : content.indexOf(endMarker, dumpStart);
        const dump = endIndex < 0 ? null : content.slice(dumpStart, endIndex);
        if (dump === null || (dump.length > 0 && !dump.endsWith('\0'))) {
          reject(
            new Error(
              signal
                ? `shell env command exited with signal ${signal}`
                : code !== 0
                  ? `shell env command exited with code ${code}`
                  : 'shell env command did not complete its environment dump'
            )
          );
          return;
        }
        // A complete frame remains usable when a later logout hook fails.
        resolve(dump);
      }
    });
  });
  return parseNullSeparatedEnv(envDump);
}

/**
 * Resolve the user's interactive shell environment.
 *
 * Tries login shell first (`-lic`), falls back to interactive (`-ic`).
 * On Windows returns empty object. Result is cached after first success.
 */
export async function resolveInteractiveShellEnv(
  options: ShellEnvResolveOptions = {}
): Promise<NodeJS.ProcessEnv> {
  if (cachedInteractiveShellEnv) {
    emitProgress(options, 'shell-env-cached', 'Using cached shell environment...');
    return cachedInteractiveShellEnv;
  }
  if (shellEnvResolvePromise) {
    emitProgress(options, 'shell-env-waiting', 'Waiting for shell environment...');
    return shellEnvResolvePromise;
  }
  if (process.platform === 'win32') {
    emitProgress(options, 'shell-env-skipped', 'Skipping shell environment on Windows...');
    cachedInteractiveShellEnv = {};
    return cachedInteractiveShellEnv;
  }

  shellEnvResolvePromise = (async () => {
    const shellPath = resolveDefaultLoginShellPath();
    try {
      emitProgress(options, 'shell-env-login', 'Reading login shell environment...');
      const loginEnv = await readShellEnv(shellPath, '-lic');
      cachedInteractiveShellEnv = loginEnv;
      clearShellEnvFailure();
      return loginEnv;
    } catch (loginError) {
      const loginMessage = loginError instanceof Error ? loginError.message : String(loginError);
      try {
        emitProgress(options, 'shell-env-interactive', 'Trying interactive shell environment...');
        const interactiveEnv = await readShellEnv(shellPath, '-ic');
        cachedInteractiveShellEnv = interactiveEnv;
        clearShellEnvFailure();
        return interactiveEnv;
      } catch (interactiveError) {
        const interactiveMessage =
          interactiveError instanceof Error ? interactiveError.message : String(interactiveError);
        logger.warn(
          `Failed to resolve shell env after login and interactive probes${formatShellEnvSource(
            options
          )}: login=${loginMessage}; interactive=${interactiveMessage}`
        );
        rememberShellEnvFailure(interactiveMessage);
        emitProgress(options, 'shell-env-fallback', 'Using current process environment...');
        return {};
      }
    } finally {
      shellEnvResolvePromise = null;
    }
  })();

  return shellEnvResolvePromise;
}

/**
 * Resolve shell env without making the caller wait for slow prompt/plugin init.
 *
 * This is deliberately additive: fallbackEnv is returned only to the current
 * caller, never cached. A successful background resolve still populates the
 * normal interactive-shell cache used by buildMergedCliPath/buildEnrichedEnv.
 */
export async function resolveInteractiveShellEnvBestEffort(
  options: ShellEnvBestEffortResolveOptions = {}
): Promise<NodeJS.ProcessEnv> {
  if (cachedInteractiveShellEnv) {
    emitProgress(options, 'shell-env-cached', 'Using cached shell environment...');
    return cachedInteractiveShellEnv;
  }

  if (process.platform === 'win32') {
    return resolveInteractiveShellEnv(options);
  }

  const fallbackEnv = options.fallbackEnv ?? {};
  const timeoutMs = Math.max(0, options.timeoutMs ?? SHELL_ENV_BEST_EFFORT_TIMEOUT_MS);
  const startedAt = Date.now();
  if (options.background === false) {
    emitProgress(options, 'shell-env-best-effort-fallback', 'Using fallback shell environment...');
    return fallbackEnv;
  }
  if (!shellEnvResolvePromise && startedAt < shellEnvFailureCooldownUntil) {
    const retryInMs = Math.max(0, shellEnvFailureCooldownUntil - startedAt);
    emitProgress(
      options,
      'shell-env-failure-cooldown',
      lastShellEnvFailureMessage
        ? `Using fallback shell environment after recent failure: ${lastShellEnvFailureMessage}`
        : `Using fallback shell environment for ${retryInMs}ms after recent failure...`
    );
    return fallbackEnv;
  }

  const resolvePromise = resolveInteractiveShellEnv(options);
  if (timeoutMs === 0) {
    emitProgress(options, 'shell-env-best-effort-fallback', 'Using fallback shell environment...');
    return fallbackEnv;
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  const fallbackPromise = new Promise<NodeJS.ProcessEnv>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      emitProgress(
        options,
        'shell-env-best-effort-timeout',
        'Shell environment is still resolving; using fallback for now...'
      );
      resolve(fallbackEnv);
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const resolvedEnv = await Promise.race([resolvePromise, fallbackPromise]);
    if (!cachedInteractiveShellEnv && shellEnvFailureCooldownUntil > startedAt) {
      return fallbackEnv;
    }
    return resolvedEnv;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/** Wait for an existing probe's successful cache result, or null when it fails. */
export async function waitForPendingShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  const pending = shellEnvResolvePromise;
  if (!pending) return cachedInteractiveShellEnv;
  const resolved = await pending;
  // Strict resolution returns an uncached {} on failure. Preserve a joiner's
  // fallback in that case, without confusing a successfully cached empty env
  // or substituting another probe's cache if discovery was cleared meanwhile.
  return resolved === cachedInteractiveShellEnv ? resolved : null;
}

/**
 * Clear the cached shell environment. Useful for testing.
 */
export function clearShellEnvCache(): void {
  cachedInteractiveShellEnv = null;
  shellEnvResolvePromise = null;
  clearShellEnvFailure();
}

/**
 * Return the cached shell environment synchronously, or null if not yet resolved.
 *
 * Use this when you need the shell env but cannot afford to wait for resolution
 * (e.g. synchronous PATH enrichment with async pre-warming at startup).
 */
export function getCachedShellEnv(): NodeJS.ProcessEnv | null {
  return cachedInteractiveShellEnv;
}

/**
 * HOME from login/interactive shell when resolved, else Electron/Node home.
 * Matches TeamProvisioningService so CLI reads the same ~/.claude as the terminal.
 */
export function getShellPreferredHome(): string {
  const fromShell = getCachedShellEnv()?.HOME?.trim();
  return fromShell || getHomeDir();
}
