import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Apple's /usr/bin/git is an installer shim when Xcode/Command Line Tools
 * are missing. Do not execute it during passive worktree readiness checks:
 * on macOS that opens a system-wide installation dialog on every call.
 */
export async function canUseGitWithoutMacInstallerPrompt(
  platform: NodeJS.Platform = process.platform,
  searchPath: string = process.env.PATH ?? ''
): Promise<boolean> {
  if (platform !== 'darwin') return true;

  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'git');
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if (!(await fs.promises.stat(candidate)).isFile()) continue;
    } catch {
      continue;
    }

    const executable = await fs.promises.realpath(candidate).catch(() => candidate);
    if (executable !== '/usr/bin/git') return true;

    // xcode-select --print-path does NOT launch the CLT installer.
    const developerDirectory = await new Promise<string | null>((resolve) => {
      execFile('/usr/bin/xcode-select', ['--print-path'], { timeout: 1_000 }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      });
    });
    if (!developerDirectory || !path.isAbsolute(developerDirectory)) return false;
    return fs.promises
      .access(path.join(developerDirectory, 'usr/bin', 'git'), fs.constants.X_OK)
      .then(
        () => true,
        () => false
      );
  }
  return false;
}

