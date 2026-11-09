import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';

export class RuntimeStatusProjectAccessDeniedError extends Error {
  constructor(readonly denial: 'EPERM' | 'EACCES') {
    super(`Project folder access denied (${denial}). Grant Agent Teams access to the project folder in system privacy settings or choose another project.`);
    this.name = 'RuntimeStatusProjectAccessDeniedError';
  }
}

/**
 * Bun 1.4.2 cannot reliably realpath() a macOS File Provider directory as its cwd.
 * Keep the selected OpenCode project explicit for both runtime status and model list;
 * never use HOME as a substitute for project-scoped inventory.
 */
export async function resolveRuntimeStatusExecutionContext(
  providerId: string,
  projectCwd: string | undefined,
  options: { platform?: NodeJS.Platform; homePath?: string; statProject?: typeof stat } = {}
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
    const info = await (options.statProject ?? stat)(projectPath);
    if (!info.isDirectory()) throw new WorkingDirectoryMissingError(projectPath);
  } catch (error) {
    if (error instanceof WorkingDirectoryMissingError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkingDirectoryMissingError(projectPath, { cause: error });
    }
    if (code === 'EPERM' || code === 'EACCES') {
      throw new RuntimeStatusProjectAccessDeniedError(code);
    }
    throw error;
  }
  const originalHome = options.homePath ?? os.homedir();
  if (!path.isAbsolute(originalHome)) throw new Error('OpenCode status requires an absolute user home');
  const home = path.resolve(originalHome);
  if (home === path.parse(home).root) throw new Error('OpenCode status requires a non-root user home');
  return { cwd: home, projectArgs: ['--project-path', projectPath] };
}
