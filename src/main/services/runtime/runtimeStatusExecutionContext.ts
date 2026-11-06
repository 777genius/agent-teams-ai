import * as os from 'node:os';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';

import { WorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';

/**
 * Bun 1.4.2 cannot reliably realpath() a macOS File Provider directory as its cwd.
 * Keep OpenCode's selected project as an explicit argument, never HOME-scoped.
 */
export async function resolveRuntimeStatusExecutionContext(
  providerId: string,
  projectCwd: string | undefined,
  options: { platform?: NodeJS.Platform; homePath?: string } = {}
): Promise<{ cwd: string | undefined; projectArgs: string[] }> {
  if (providerId !== 'opencode' || (options.platform ?? process.platform) !== 'darwin' ||
      !projectCwd || !path.isAbsolute(projectCwd)) {
    return { cwd: projectCwd, projectArgs: [] };
  }
  const projectPath = path.resolve(projectCwd);
  if (projectPath === path.parse(projectPath).root) {
    return { cwd: projectCwd, projectArgs: [] };
  }
  // Preserve missing-project detection formerly supplied by spawn(cwd).
  try {
    const info = await stat(projectPath);
    if (!info.isDirectory()) throw new WorkingDirectoryMissingError(projectPath);
  } catch (error) {
    if (error instanceof WorkingDirectoryMissingError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkingDirectoryMissingError(projectPath, { cause: error });
    }
    throw error;
  }
  const originalHome = options.homePath ?? os.homedir();
  if (!path.isAbsolute(originalHome)) throw new Error('OpenCode status requires an absolute user home');
  const home = path.resolve(originalHome);
  if (home === path.parse(home).root) throw new Error('OpenCode status requires a non-root user home');
  return { cwd: home, projectArgs: ['--project-path', projectPath] };
}
