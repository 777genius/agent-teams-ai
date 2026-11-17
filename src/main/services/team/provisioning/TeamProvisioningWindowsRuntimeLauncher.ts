import fs from 'node:fs';
import path from 'node:path';

import { spawnCli } from '@main/utils/childProcess';

import type { ChildProcess, SpawnOptions } from 'node:child_process';

const WRAPPER_PATH = ['runtime', 'teammate-console', 'teammate.exe'] as const;
const TARGET_ENV = 'AGENT_TEAMS_TEAMMATE_WRAPPER_TARGET';
const ownedWindowsTeammateWrappers = new WeakSet<ChildProcess>();

/** Only processes spawned through our staged Job wrapper have native tree custody. */
export function isOwnedWindowsTeamRuntimeWrapperProcess(child: ChildProcess): boolean {
  return ownedWindowsTeammateWrappers.has(child);
}

/**
 * Infrastructure implementation of the existing team provisioning spawn port.
 * No staged-resource filesystem lookup is performed in launch use cases.
 */
export function spawnWindowsTeamRuntimeCli(
  binaryPath: string,
  args: string[],
  options: SpawnOptions = {}
): ReturnType<typeof spawnCli> {
  const launch = resolveWindowsTeamRuntimeLauncher(binaryPath, {
    requireWrapper: process.env.AGENT_TEAMS_REQUIRE_TEAMMATE_WRAPPER === '1',
  });
  if (!launch.targetEnv) return spawnCli(launch.binaryPath, args, options);
  const child = spawnCli(launch.binaryPath, args, {
    ...options,
    env: { ...(options.env ?? process.env), ...launch.targetEnv },
  });
  ownedWindowsTeammateWrappers.add(child);
  return child;
}

export interface WindowsTeamRuntimeLaunch {
  binaryPath: string;
  targetEnv?: NodeJS.ProcessEnv;
}

/** One composition seam for lead, direct member, and lead auth-retry spawns. */
export function resolveWindowsTeamRuntimeLauncher(
  binaryPath: string,
  options: {
    platform?: NodeJS.Platform;
    resourcesPath?: string;
    requireWrapper?: boolean;
  } = {}
): WindowsTeamRuntimeLaunch {
  if ((options.platform ?? process.platform) !== 'win32') return { binaryPath };
  if (!path.isAbsolute(binaryPath) || path.extname(binaryPath).toLowerCase() !== '.exe') {
    if (options.requireWrapper)
      throw new Error('Required Windows teammate Job wrapper needs an absolute .exe target');
    return { binaryPath };
  }
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, ...WRAPPER_PATH)] : []),
    path.join(path.dirname(binaryPath), 'teammate-console', 'teammate.exe'),
  ];
  for (const candidate of candidates) {
    try {
      // Staged ordinary files only: never follow a symlink to a different binary.
      if (
        path.resolve(candidate).toLowerCase() !== path.resolve(binaryPath).toLowerCase() &&
        fs.lstatSync(candidate).isFile()
      ) {
        return { binaryPath: candidate, targetEnv: { [TARGET_ENV]: binaryPath } };
      }
    } catch {
      // Only development without strict Windows qualification may fall back.
    }
  }
  if (options.requireWrapper) throw new Error('Required Windows teammate Job wrapper is missing');
  return { binaryPath };
}
