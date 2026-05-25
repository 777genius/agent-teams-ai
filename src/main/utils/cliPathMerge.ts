/**
 * Merged PATH for Claude CLI discovery and child processes.
 * Packaged macOS apps get a minimal PATH; login-shell cache fixes that once warm.
 */

import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';
import { realpathSync } from 'fs';
import { posix as pathPosix, win32 as pathWin32 } from 'path';

/**
 * Build a PATH string that prefers the CLI binary directory, then the user's
 * interactive shell PATH (when cached), then common install locations, then the
 * current process PATH.
 */
export function buildMergedCliPath(binaryPath?: string | null): string {
  const home = getShellPreferredHome();
  const sep = process.platform === 'win32' ? pathWin32.delimiter : pathPosix.delimiter;
  const pathForBin = process.platform === 'win32' ? pathWin32 : pathPosix;
  const currentPath = process.env.PATH || '';
  const extraDirs: string[] = [];
  const vendorBinDir = pathForBin.join(getClaudeBasePath(), 'local', 'node_modules', '.bin');

  if (binaryPath) {
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
  }

  if (process.platform === 'win32') {
    extraDirs.push(
      vendorBinDir,
      pathWin32.join(home, 'AppData', 'Roaming', 'npm'),
      pathWin32.join(home, 'scoop', 'shims'),
      pathWin32.join(home, '.bun', 'bin'),
      pathWin32.join(home, '.cargo', 'bin'),
      pathWin32.join(home, '.volta', 'bin')
    );
    if (process.env.LOCALAPPDATA) {
      extraDirs.push(
        pathWin32.join(process.env.LOCALAPPDATA, 'Programs', 'claude'),
        pathWin32.join(process.env.LOCALAPPDATA, 'pnpm')
      );
    }
    if (process.env.ProgramFiles) {
      extraDirs.push(
        pathWin32.join(process.env.ProgramFiles, 'claude'),
        pathWin32.join(process.env.ProgramFiles, 'nodejs')
      );
    }
  } else {
    extraDirs.push(
      vendorBinDir,
      pathPosix.join(home, '.bun', 'bin'),
      pathPosix.join(home, '.local', 'bin'),
      pathPosix.join(home, '.npm-global', 'bin'),
      pathPosix.join(home, '.npm', 'bin'),
      pathPosix.join(home, '.asdf', 'shims'),
      pathPosix.join(home, '.local', 'share', 'mise', 'shims'),
      pathPosix.join(home, '.volta', 'bin'),
      pathPosix.join(home, 'Library', 'pnpm'),
      pathPosix.join(home, '.local', 'share', 'pnpm'),
      pathPosix.join(home, '.cargo', 'bin'),
      pathPosix.join(home, '.nix-profile', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
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
