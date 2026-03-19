/**
 * Merged PATH for Claude CLI discovery and child processes.
 * Packaged macOS apps get a minimal PATH; login-shell cache fixes that once warm.
 */

import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';
import { realpathSync } from 'fs';
import { join as pathJoin, posix as pathPosix, win32 as pathWin32 } from 'path';

/**
 * Build a PATH string that prefers the CLI binary directory, then the user's
 * interactive shell PATH (when cached), then common install locations, then the
 * current process PATH.
 */
export function buildMergedCliPath(binaryPath?: string | null): string {
  const home = getShellPreferredHome();
  const sep = process.platform === 'win32' ? pathWin32.delimiter : pathPosix.delimiter;
  const currentPath = process.env.PATH || '';
  const extraDirs: string[] = [];

  if (binaryPath) {
    const pathForBin = process.platform === 'win32' ? pathWin32 : pathPosix;
    const binDir = pathForBin.dirname(binaryPath);
    extraDirs.push(binDir);
    try {
      const realBinDir = pathForBin.dirname(realpathSync(binaryPath));
      if (realBinDir !== binDir) {
        extraDirs.push(realBinDir);
      }
    } catch {
      /* symlink resolution failed — ignore */
    }
  }

  const cachedEnv = getCachedShellEnv();
  if (cachedEnv?.PATH) {
    extraDirs.push(...cachedEnv.PATH.split(sep).filter(Boolean));
  } else if (process.platform === 'win32') {
    extraDirs.push(pathJoin(home, 'AppData', 'Roaming', 'npm'), pathJoin(home, 'scoop', 'shims'));
    if (process.env.LOCALAPPDATA) {
      extraDirs.push(pathJoin(process.env.LOCALAPPDATA, 'Programs', 'claude'));
    }
    if (process.env.ProgramFiles) {
      extraDirs.push(pathJoin(process.env.ProgramFiles, 'claude'));
    }
  } else {
    extraDirs.push(
      pathPosix.join(home, '.local', 'bin'),
      pathPosix.join(home, '.npm-global', 'bin'),
      pathPosix.join(home, '.npm', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin'
    );
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...extraDirs, ...currentPath.split(sep)]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }

  return merged.join(sep);
}
