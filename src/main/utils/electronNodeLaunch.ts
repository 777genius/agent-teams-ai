import { isAbsolute, join } from 'node:path';

import {
  captureLinuxNodeExecArtifact, validateLinuxNodeExecArtifact,
} from './linuxNodeExecArtifact';

import type { LinuxNodeExecArtifact } from './linuxNodeExecArtifact';

let captured: LinuxNodeExecArtifact | undefined;

/**
 * Only the existing direct Node/three-pipe boundaries use this recipe.
 * The native stage execs that selected Node in the original ChildProcess.
 */
export async function resolveElectronNodeLaunch(
  nodeExecutable: string,
  args: readonly string[]
): Promise<{ command: string; args: string[] }> {
  if (process.platform !== 'linux' || !process.versions.electron || process.type !== 'browser')
    return { command: nodeExecutable, args: [...args] };
  if (!isAbsolute(nodeExecutable) || nodeExecutable.includes('\0') ||
      args.some((arg) => arg.includes('\0')))
    throw new Error('Invalid selected Node launch');
  if (!captured) {
    const { app } = await import('electron');
    const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
    captured ??= captureLinuxNodeExecArtifact(join(resources, 'process-launch', 'linux-x64'));
  }
  validateLinuxNodeExecArtifact(captured);
  return { command: captured.path, args: ['--', nodeExecutable, ...args] };
}
