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

import { createLogger } from '@shared/utils/logger';
import { spawn } from 'child_process';

const logger = createLogger('Utils:shellEnv');

const SHELL_ENV_TIMEOUT_MS = 12_000;

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;
let shellEnvResolvePromise: Promise<NodeJS.ProcessEnv> | null = null;

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
    child.once('close', () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!settled) {
        settled = true;
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
export async function resolveInteractiveShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedInteractiveShellEnv) {
    return cachedInteractiveShellEnv;
  }
  if (shellEnvResolvePromise) {
    return shellEnvResolvePromise;
  }
  if (process.platform === 'win32') {
    cachedInteractiveShellEnv = {};
    return cachedInteractiveShellEnv;
  }

  shellEnvResolvePromise = (async () => {
    const shellPath = process.env.SHELL || '/bin/zsh';
    try {
      const loginEnv = await readShellEnv(shellPath, ['-lic', 'env -0']);
      cachedInteractiveShellEnv = loginEnv;
      return loginEnv;
    } catch (loginError) {
      const loginMessage = loginError instanceof Error ? loginError.message : String(loginError);
      logger.warn(`Failed to resolve login shell env: ${loginMessage}`);
      try {
        const interactiveEnv = await readShellEnv(shellPath, ['-ic', 'env -0']);
        cachedInteractiveShellEnv = interactiveEnv;
        return interactiveEnv;
      } catch (interactiveError) {
        const interactiveMessage =
          interactiveError instanceof Error ? interactiveError.message : String(interactiveError);
        logger.warn(`Failed to resolve interactive shell env: ${interactiveMessage}`);
        return {};
      }
    } finally {
      shellEnvResolvePromise = null;
    }
  })();

  return shellEnvResolvePromise;
}

/**
 * Clear the cached shell environment. Useful for testing.
 */
export function clearShellEnvCache(): void {
  cachedInteractiveShellEnv = null;
  shellEnvResolvePromise = null;
}
