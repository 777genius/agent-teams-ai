import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import { collectExternalProcessTreeIdentities } from '@main/utils/externalProcessTreeKill';
import { isProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import {
  isSameUnixProcessIdentity,
  tryReadUnixProcessTable,
  type UnixProcessIdentity,
} from '@main/utils/unixProcessTable';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { execFileSync } from 'child_process';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import type {
  PendingPersistentProcessStop,
  PersistentRuntimeStopVerdict,
} from './TeamProvisioningPersistentRuntimeCleanup';
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
 * table is only the discovery channel for unrecorded orphans; recorded pids are
 * evidence for the verdict, never kill targets: after a crash or reboot a stale
 * recorded pid can belong to a foreign process, so only table-attributed
 * processes are ever signalled and only under a captured birth identity.
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
  // When the table is readable it is the attribution authority: a recorded pid
  // counts as live only while the table attributes it to the team. Without the
  // table liveness is the fallback evidence for the recorded launch pids.
  const attributedRows = input.rows
    ? input.rows.filter((row) => commandArgEquals(row.command, '--team-name', input.teamName))
    : null;
  const liveRecordedPids = recordedPids.filter((pid) => {
    try {
      return attributedRows ? attributedRows.some((row) => row.pid === pid) : input.isPidAlive(pid);
    } catch {
      return false;
    }
  });
  const targetPids = discoveredPids;
  if (!input.rows && recordedPids.length === 0) {
    return {
      verdict: { confirmed: false, reason: 'process_table_unreadable' },
      targetPids,
    };
  }
  return {
    verdict:
      targetPids.length === 0 && liveRecordedPids.length === 0
        ? { confirmed: true }
        : { confirmed: false, reason: 'live_agent_processes' },
    targetPids,
  };
}

interface OrphanedProcessStopPorts {
  readRows(): { pid: number; command: string }[] | null;
  readIdentities(): Map<number, UnixProcessIdentity> | null;
  killPid(pid: number): void;
  isPidAlive(pid: number): boolean;
}

const ORPHAN_EXIT_TIMEOUT_MS = 5_000;
const ORPHAN_EXIT_POLL_MS = 250;

export function killOrphanedTeamAgentProcesses(
  input: {
    teamName: string;
    currentRunPid?: number;
    knownPids?: readonly number[];
    isRecheck?: boolean;
    logger: StopProcessCleanupLogger;
  },
  overrides: Partial<OrphanedProcessStopPorts> = {}
): PersistentRuntimeStopVerdict | PendingPersistentProcessStop {
  // The Windows probe is synchronous and times out slowly under load; honour
  // its failure cooldown only when recorded pids can prove exit without the
  // table and this is not a settle re-check that needs fresh evidence.
  const allowCooldown = (input.knownPids?.length ?? 0) > 0 && input.isRecheck !== true;
  const ports: OrphanedProcessStopPorts = {
    readRows: () => readProcessRows({ allowCooldown }),
    readIdentities: tryReadUnixProcessTable,
    killPid: killProcessByPid,
    isPidAlive: isProcessAlive,
    ...overrides,
  };
  const rows = ports.readRows();
  const { verdict, targetPids } = resolveOrphanedTeamAgentStopVerdict({
    rows,
    teamName: input.teamName,
    currentRunPid: input.currentRunPid,
    knownPids: input.knownPids,
    isPidAlive: ports.isPidAlive,
  });
  if (verdict.confirmed) return verdict;
  if (!rows || targetPids.length === 0) return verdict;
  // Windows has no captured birth identities on this legacy taskkill path.
  if (process.platform === 'win32') {
    for (const pid of targetPids) {
      try {
        ports.killPid(pid);
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
  const captured = new Map<number, UnixProcessIdentity>();
  const signalSent = new Set<number>();
  let discoveryComplete = false;
  let currentRunPid = input.currentRunPid;
  function stopNewProcesses(nextRunPid: number | undefined): void {
    currentRunPid = nextRunPid;
    discoveryComplete = false;
    const discoveredRows = ports.readRows();
    const identities = ports.readIdentities();
    if (!discoveredRows || !identities) return;
    // A different birth proves the old process has exited; it grants no rights
    // over the successor. Only current matching-root discovery can capture it.
    for (const [pid, identity] of captured) {
      const observed = identities.get(pid);
      if (!observed || observed.startIdentity !== identity.startIdentity) {
        captured.delete(pid);
        signalSent.delete(pid);
      }
    }
    const roots = selectOrphanedTeamAgentPids(discoveredRows, input.teamName, currentRunPid);
    let complete = true;
    // Rebuild deepest-first order on every explicit Stop: an unsent old parent
    // may have acquired a child since the previous attempt.
    const ordered = new Map<number, UnixProcessIdentity>();
    for (const pid of new Set([...roots, ...captured.keys()])) {
      const previousRoot = captured.get(pid);
      const observedRoot = identities.get(pid);
      if (
        previousRoot &&
        observedRoot &&
        previousRoot.processGroupId !== observedRoot.processGroupId
      ) {
        complete = false;
        continue;
      }
      const tree = collectExternalProcessTreeIdentities(identities, pid, process.pid);
      if ('refusal' in tree || tree.identities.length === 0) {
        complete = false;
        continue;
      }
      for (const identity of tree.identities) {
        const previous = captured.get(identity.pid);
        try {
          if (previous && !isSameUnixProcessIdentity(previous, identity)) {
            complete = false;
            continue;
          }
        } catch {
          complete = false;
          continue;
        }
        ordered.set(identity.pid, identity);
      }
    }
    for (const [pid, identity] of ordered) captured.set(pid, identity);
    discoveryComplete = complete;
    for (const [pid, expected] of ordered) {
      if (signalSent.has(pid)) continue;
      try {
        const current = ports.readIdentities();
        if (!current || !current.has(pid)) continue;
        if (!isSameUnixProcessIdentity(expected, current.get(pid))) continue;
        ports.killPid(pid);
        signalSent.add(pid);
        input.logger.info(
          `[${input.teamName}] Signalled orphaned teammate process pid=${pid} during stop`
        );
      } catch (error) {
        input.logger.debug(
          `[${input.teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  stopNewProcesses(currentRunPid);
  if (!discoveryComplete && captured.size === 0) {
    return { confirmed: false, reason: 'live_agent_processes' };
  }
  return {
    stopNewProcesses,
    async confirmStopped() {
      if (!discoveryComplete) return false;
      const deadline = Date.now() + ORPHAN_EXIT_TIMEOUT_MS;
      while (true) {
        const currentRows = ports.readRows();
        const current = ports.readIdentities();
        if (!currentRows || !current) return false;
        // A newly launched matching process is not owned by this receipt.
        if (
          [...selectOrphanedTeamAgentPids(currentRows, input.teamName, currentRunPid)].some(
            (pid) => {
              const expected = captured.get(pid);
              const observed = current.get(pid);
              return !expected || !observed || expected.startIdentity !== observed.startIdentity;
            }
          )
        )
          return false;
        let remaining = false;
        for (const [pid, identity] of captured) {
          const observed = current.get(pid);
          if (!observed || observed.startIdentity !== identity.startIdentity) continue;
          // Same birth with changed process-group authority remains a refusal.
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

const WIN32_PROBE_FAILURE_COOLDOWN_MS = 15_000;
let win32ProbeUnreadableUntil = 0;

export function readProcessRows(options: { allowCooldown?: boolean } = {}):
  | {
      pid: number;
      command: string;
    }[]
  | null {
  const rows: { pid: number; command: string }[] = [];

  if (process.platform === 'win32') {
    // The probe is synchronous and times out slowly under load; hammering it
    // stacks blocked probes on the stop path while recorded pids can already
    // prove exit without it. Re-checks and evidence-less calls bypass the
    // cooldown so they always get a fresh probe.
    if (options.allowCooldown !== false && Date.now() < win32ProbeUnreadableUntil) return null;
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
