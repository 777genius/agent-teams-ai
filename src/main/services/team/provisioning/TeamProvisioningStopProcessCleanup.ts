import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import { collectExternalProcessTreeIdentities } from '@main/utils/externalProcessTreeKill';
import { killProcessByPid } from '@main/utils/processKill';
import {
  isSameUnixProcessIdentity,
  tryReadUnixProcessTable,
  type UnixProcessIdentity,
} from '@main/utils/unixProcessTable';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { execFileSync } from 'child_process';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import type { PendingPersistentProcessStop } from './TeamProvisioningPersistentRuntimeCleanup';
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
): boolean {
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
  return confirmed;
}

interface OrphanedProcessStopPorts {
  readRows(): { pid: number; command: string }[] | null;
  readIdentities(): Map<number, UnixProcessIdentity> | null;
  killPid(pid: number): void;
}

const ORPHAN_EXIT_TIMEOUT_MS = 5_000;
const ORPHAN_EXIT_POLL_MS = 50;

export function killOrphanedTeamAgentProcesses(
  input: {
    teamName: string;
    currentRunPid?: number;
    logger: StopProcessCleanupLogger;
  },
  overrides: Partial<OrphanedProcessStopPorts> = {}
): boolean | PendingPersistentProcessStop {
  const ports: OrphanedProcessStopPorts = {
    readRows: readProcessRows,
    readIdentities: tryReadUnixProcessTable,
    killPid: killProcessByPid,
    ...overrides,
  };
  const rows = ports.readRows();
  if (!rows) return false;
  const targetPids = selectOrphanedTeamAgentPids(rows, input.teamName, input.currentRunPid);
  if (targetPids.size === 0) return true;
  const captured = new Map<number, UnixProcessIdentity>();
  if (process.platform !== 'win32') {
    const identities = ports.readIdentities();
    if (!identities) return false;
    for (const pid of targetPids) {
      const tree = collectExternalProcessTreeIdentities(identities, pid, process.pid);
      if ('refusal' in tree || tree.identities.length === 0) return false;
      for (const identity of tree.identities) captured.set(identity.pid, identity);
    }
  }
  let signalFailed = false;
  for (const pid of targetPids) {
    try {
      if (process.platform !== 'win32') {
        const current = ports.readIdentities();
        if (!current) {
          signalFailed = true;
          continue;
        }
        if (!current.has(pid)) continue;
        const expected = captured.get(pid);
        if (!expected || !isSameUnixProcessIdentity(expected, current.get(pid))) {
          signalFailed = true;
          continue;
        }
      }
      ports.killPid(pid);
      input.logger.info(
        `[${input.teamName}] Signalled orphaned teammate process pid=${pid} during stop`
      );
    } catch (error) {
      signalFailed = true;
      input.logger.debug(
        `[${input.teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  // Windows' legacy taskkill helper is fire-and-forget and has no captured
  // birth identities here. Preserve its honest refusal rather than infer exit.
  if (process.platform === 'win32' || signalFailed) return false;
  return {
    async confirmStopped() {
      const deadline = Date.now() + ORPHAN_EXIT_TIMEOUT_MS;
      while (true) {
        const currentRows = ports.readRows();
        const current = ports.readIdentities();
        if (!currentRows || !current) return false;
        // A newly launched matching process is not owned by this receipt.
        if (
          [...selectOrphanedTeamAgentPids(currentRows, input.teamName, input.currentRunPid)].some(
            (pid) => !captured.has(pid)
          )
        )
          return false;
        let remaining = false;
        for (const [pid, identity] of captured) {
          const observed = current.get(pid);
          if (!observed) continue;
          // PID reuse is not authority to finalize the successor or signal it.
          try {
            if (!isSameUnixProcessIdentity(identity, observed)) return false;
          } catch {
            return false;
          }
          remaining = true;
        }
        if (!remaining) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, ORPHAN_EXIT_POLL_MS));
      }
    },
  };
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
