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

const logger = createLogger('Utils:shellEnv');

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
}

export interface ShellEnvResolveOptions {
  onProgress?: (progress: ShellEnvResolveProgress) => void;
}

export interface ShellEnvBestEffortResolveOptions extends ShellEnvResolveOptions {
  /**
   * Max time to wait on the critical path before returning fallbackEnv.
   * The full shell resolve continues in the background and caches on success.
   */
  timeoutMs?: number;
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
  options?.onProgress?.({ phase, message });
}

function rememberShellEnvFailure(message: string): void {
  lastShellEnvFailureMessage = message;
  shellEnvFailureCooldownUntil = Date.now() + SHELL_ENV_FAILURE_COOLDOWN_MS;
}

function clearShellEnvFailure(): void {
  lastShellEnvFailureMessage = null;
  shellEnvFailureCooldownUntil = 0;
}

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

async function readShellEnv(shellPath: string, args: string[]): Promise<NodeJS.ProcessEnv> {
  const envDump = await new Promise<string>((resolve, reject) => {
    const child = spawn(shellPath, args, {
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
        if (chunks.length === 0 && (code !== 0 || signal)) {
          reject(
            new Error(
              signal
                ? `shell env command exited with signal ${signal}`
                : `shell env command exited with code ${code}`
            )
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
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
    const shellPath = process.env.SHELL || '/bin/zsh';
    try {
      emitProgress(options, 'shell-env-login', 'Reading login shell environment...');
      const loginEnv = await readShellEnv(shellPath, ['-lic', 'env -0']);
      cachedInteractiveShellEnv = loginEnv;
      clearShellEnvFailure();
      return loginEnv;
    } catch (loginError) {
      const loginMessage = loginError instanceof Error ? loginError.message : String(loginError);
      logger.warn(`Failed to resolve login shell env: ${loginMessage}`);
      try {
        emitProgress(options, 'shell-env-interactive', 'Trying interactive shell environment...');
        const interactiveEnv = await readShellEnv(shellPath, ['-ic', 'env -0']);
        cachedInteractiveShellEnv = interactiveEnv;
        clearShellEnvFailure();
        return interactiveEnv;
      } catch (interactiveError) {
        const interactiveMessage =
          interactiveError instanceof Error ? interactiveError.message : String(interactiveError);
        logger.warn(`Failed to resolve interactive shell env: ${interactiveMessage}`);
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
