import { isAbsolute, join } from 'node:path';

import { hasSelectedLinuxChildLaunch } from './linuxChildLaunchSelection';
import {
  captureLinuxNodeExecArtifact, validateLinuxNodeExecArtifact,
} from './linuxNodeExecArtifact';

import type { LinuxNodeExecArtifact } from './linuxNodeExecArtifact';

let captured: LinuxNodeExecArtifact | undefined;

/**
 * Direct callers retain the pinned Node/three-pipe recipe. Generic-owned
 * callers use its one stage when selected, with validation at allocation.
 */
export async function resolveElectronNodeLaunch(
  nodeExecutable: string,
  args: readonly string[],
  allocation: 'direct' | 'generic' = 'direct'
): Promise<{ command: string; args: string[] }> {
  if (process.platform !== 'linux' || !process.versions.electron || process.type !== 'browser')
    return { command: nodeExecutable, args: [...args] };
  if (!isAbsolute(nodeExecutable) || nodeExecutable.includes('\0') ||
      args.some((arg) => arg.includes('\0')))
    throw new Error('Invalid selected Node launch');
  if (allocation === 'generic' && hasSelectedLinuxChildLaunch())
    return { command: nodeExecutable, args: [...args] };
  if (!captured) {
    const { app } = await import('electron');
    const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
    captured ??= captureLinuxNodeExecArtifact(join(resources, 'process-launch', 'linux-x64'));
  }
  validateLinuxNodeExecArtifact(captured);
  return { command: captured.path, args: ['--', nodeExecutable, ...args] };
}
