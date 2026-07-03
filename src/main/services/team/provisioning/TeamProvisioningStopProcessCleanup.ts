import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import { killProcessByPid } from '@main/utils/processKill';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { execFileSync } from 'child_process';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export interface StopProcessCleanupLogger {
  info(message: string): void;
  debug(message: string): void;
}

export function getPersistedPaneMemberKillTargets(
  members: PersistedRuntimeMemberLike[]
): { name: string; paneId: string }[] {
  return members.flatMap((member) => {
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    const paneId = typeof member.tmuxPaneId === 'string' ? member.tmuxPaneId.trim() : '';
    const backendType =
      typeof member.backendType === 'string' ? member.backendType.trim().toLowerCase() : '';
    if (!name || name === 'team-lead' || !paneId || backendType !== 'tmux') {
      return [];
    }
    return [{ name, paneId }];
  });
}

export function killPersistedPaneMembers(
  teamName: string,
  members: PersistedRuntimeMemberLike[],
  logger: StopProcessCleanupLogger
): void {
  for (const { name, paneId } of getPersistedPaneMemberKillTargets(members)) {
    try {
      killTmuxPaneForCurrentPlatformSync(paneId);
      logger.info(`[${teamName}] Killed teammate pane ${name} (${paneId}) during stop`);
    } catch (error) {
      logger.debug(
        `[${teamName}] Failed to kill teammate pane ${name} (${paneId}) during stop: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function killOrphanedTeamAgentProcesses(input: {
  teamName: string;
  currentRunPid?: number;
  logger: StopProcessCleanupLogger;
}): void {
  const rows = readProcessRows();
  if (!rows) {
    return;
  }

  for (const pid of selectOrphanedTeamAgentPids(rows, input.teamName, input.currentRunPid)) {
    try {
      killProcessByPid(pid);
      input.logger.info(`[${input.teamName}] Killed orphaned teammate process pid=${pid} during stop`);
    } catch (error) {
      input.logger.debug(
        `[${input.teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function selectOrphanedTeamAgentPids(
  rows: { pid: number; command: string }[],
  teamName: string,
  currentRunPid?: number
): Set<number> {
  const pids = new Set<number>();
  for (const row of rows) {
    if (
      !commandArgEquals(row.command, '--team-name', teamName) ||
      !row.command.includes('--agent-id')
    ) {
      continue;
    }
    if (currentRunPid && row.pid === currentRunPid) continue;
    pids.add(row.pid);
  }
  return pids;
}

export function readProcessRows(): { pid: number; command: string }[] | null {
  const rows: { pid: number; command: string }[] = [];

  if (process.platform === 'win32') {
    try {
      rows.push(
        ...listWindowsProcessTableSync().map((row) => ({ pid: row.pid, command: row.command }))
      );
    } catch {
      return null;
    }
    return rows;
  }

  let output = '';
  try {
    output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, command: match[2] ?? '' });
  }

  return rows;
}
