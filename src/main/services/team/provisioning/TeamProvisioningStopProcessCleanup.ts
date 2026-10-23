import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import { isProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { execFileSync } from 'child_process';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import type { PersistentRuntimeStopVerdict } from './TeamProvisioningPersistentRuntimeCleanup';
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
): PersistentRuntimeStopVerdict {
  let confirmed = true;
  for (const { name, paneId } of getPersistedPaneMemberKillTargets(members)) {
    try {
      killTmuxPaneForCurrentPlatformSync(paneId);
      logger.info(`[${teamName}] Killed teammate pane ${name} (${paneId}) during stop`);
    } catch (error) {
      confirmed = false;
      logger.debug(
        `[${teamName}] Failed to kill teammate pane ${name} (${paneId}) during stop: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return confirmed ? { confirmed } : { confirmed, reason: 'pane_kill_failed' };
}

/**
 * Decide stop confirmation from whatever evidence is available. The process
 * table is only the discovery channel for unrecorded orphans; exit proof for
 * the owned runtime comes from the recorded launch-snapshot pids, which hold
 * even when the table probe is unreadable.
 */
export function resolveOrphanedTeamAgentStopVerdict(input: {
  rows: { pid: number; command: string }[] | null;
  teamName: string;
  currentRunPid?: number;
  knownPids?: readonly number[];
  isPidAlive: (pid: number) => boolean;
}): { verdict: PersistentRuntimeStopVerdict; targetPids: number[] } {
  const recordedPids = (input.knownPids ?? []).filter(
    (pid) => Number.isFinite(pid) && pid > 0 && pid !== input.currentRunPid
  );
  const discoveredPids = input.rows
    ? [...selectOrphanedTeamAgentPids(input.rows, input.teamName, input.currentRunPid)]
    : [];
  const liveRecordedPids = recordedPids.filter((pid) => {
    try {
      return input.isPidAlive(pid);
    } catch {
      return false;
    }
  });
  const targetPids = [...new Set([...discoveredPids, ...liveRecordedPids])];
  if (!input.rows && recordedPids.length === 0) {
    return {
      verdict: { confirmed: false, reason: 'process_table_unreadable' },
      targetPids,
    };
  }
  return {
    verdict:
      targetPids.length === 0
        ? { confirmed: true }
        : { confirmed: false, reason: 'live_agent_processes' },
    targetPids,
  };
}

export function killOrphanedTeamAgentProcesses(input: {
  teamName: string;
  currentRunPid?: number;
  knownPids?: readonly number[];
  logger: StopProcessCleanupLogger;
}): PersistentRuntimeStopVerdict {
  const rows = readProcessRows();
  const { verdict, targetPids } = resolveOrphanedTeamAgentStopVerdict({
    rows,
    teamName: input.teamName,
    currentRunPid: input.currentRunPid,
    knownPids: input.knownPids,
    isPidAlive: isProcessAlive,
  });
  // The legacy helper only dispatches termination (and is fire-and-forget on
  // Windows), so any still-live target keeps the stop unconfirmed until a later
  // settle re-check finds it gone. A dispatched signal is not process exit.
  for (const pid of targetPids) {
    try {
      killProcessByPid(pid);
      input.logger.info(
        `[${input.teamName}] Killed orphaned teammate process pid=${pid} during stop`
      );
    } catch (error) {
      input.logger.debug(
        `[${input.teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return verdict;
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

const WIN32_PROBE_FAILURE_COOLDOWN_MS = 15_000;
let win32ProbeUnreadableUntil = 0;

export function readProcessRows(): { pid: number; command: string }[] | null {
  const rows: { pid: number; command: string }[] = [];

  if (process.platform === 'win32') {
    // The probe is synchronous and times out slowly under load; hammering it
    // stacks blocked probes on the stop path while recorded pids can already
    // prove exit without it.
    if (Date.now() < win32ProbeUnreadableUntil) return null;
    try {
      rows.push(
        ...listWindowsProcessTableSync().map((row) => ({ pid: row.pid, command: row.command }))
      );
    } catch {
      win32ProbeUnreadableUntil = Date.now() + WIN32_PROBE_FAILURE_COOLDOWN_MS;
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
