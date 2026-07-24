import { isProcessAlive as defaultIsProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { isOpenCodeServeCommand } from '../opencode/bridge/OpenCodeManagedHostProcessCleanup';
import {
  clearOpenCodeRuntimeLaneStorage,
  type OpenCodeRuntimeLaneIndex,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { extractOpenCodeRuntimeLaneMemberName } from './TeamProvisioningOpenCodeRuntimePermissions';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

export type StoppedOpenCodeRuntimeLanePidStopResult = 'stopped' | 'no_pid' | 'unsafe';

export interface PersistedTeamProcessHealthPorts {
  isProcessAlive(pid: number): boolean;
}

export interface StoppedOpenCodeRuntimeLanePidStopPorts {
  readProcessCommandByPid(pid: number): string | null;
  isOpenCodeServeCommand(command: string): boolean;
  killProcessByPid(pid: number): void;
  logInfo(message: string): void;
  logWarning(message: string): void;
}

export interface StopOpenCodeRuntimeLanesForStoppedTeamPorts {
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readPreviousLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readConfigForObservation(teamName: string): Promise<TeamConfig | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  readPersistedTeamProjectPath(teamName: string): string | null;
  tryStopPersistedOpenCodeRuntimePidForStoppedLane(input: {
    teamName: string;
    laneId: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): StoppedOpenCodeRuntimeLanePidStopResult;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearPrimaryRuntimeRun(teamName: string): void;
  markStoppedTeamOpenCodeRuntimeLanesCleaned(teamName: string): void;
  logWarning(message: string): void;
}

export function cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(input: {
  teamName: string;
  stopOpenCodeRuntimeLanesForStoppedTeam(teamName: string): Promise<number>;
  logWarning(message: string): void;
}): void {
  void input.stopOpenCodeRuntimeLanesForStoppedTeam(input.teamName).catch((error) => {
    input.logWarning(
      `[${input.teamName}] Failed to clean up stopped-team OpenCode runtime lanes: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}

export function stopOpenCodeRuntimeLanesForStoppedTeamOnce(input: {
  teamName: string;
  inFlight: Map<string, Promise<number>>;
  stopInternal(teamName: string): Promise<number>;
}): Promise<number> {
  const existing = input.inFlight.get(input.teamName);
  if (existing) {
    return existing;
  }
  const cleanup = input.stopInternal(input.teamName).finally(() => {
    if (input.inFlight.get(input.teamName) === cleanup) {
      input.inFlight.delete(input.teamName);
    }
  });
  input.inFlight.set(input.teamName, cleanup);
  return cleanup;
}

export function readPersistedTeamProcessRows(input: {
  teamsBasePath: string;
  teamName: string;
}): unknown[] | null {
  const processesPath = path.join(input.teamsBasePath, input.teamName, 'processes.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(processesPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed as unknown[];
}

export function hasAlivePersistedTeamProcessRows(
  rows: readonly unknown[] | null,
  ports: PersistedTeamProcessHealthPorts
): boolean {
  if (!Array.isArray(rows)) {
    return false;
  }
  return rows.some((row) => {
    if (!row || typeof row !== 'object') {
      return false;
    }
    const processRow = row as { pid?: unknown; stoppedAt?: unknown };
    return (
      typeof processRow.pid === 'number' &&
      Number.isFinite(processRow.pid) &&
      processRow.stoppedAt == null &&
      ports.isProcessAlive(processRow.pid)
    );
  });
}

export function hasAlivePersistedTeamProcess(input: {
  teamsBasePath: string;
  teamName: string;
  isProcessAlive?: (pid: number) => boolean;
}): boolean {
  return hasAlivePersistedTeamProcessRows(readPersistedTeamProcessRows(input), {
    isProcessAlive: input.isProcessAlive ?? defaultIsProcessAlive,
  });
}

export function hasOnlyExplicitlyStoppedPersistedTeamProcessRows(
  rows: readonly unknown[] | null
): boolean {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  return rows.every((row) => {
    if (!row || typeof row !== 'object') {
      return false;
    }
    return (row as { stoppedAt?: unknown }).stoppedAt != null;
  });
}

export function hasOnlyExplicitlyStoppedPersistedTeamProcesses(input: {
  teamsBasePath: string;
  teamName: string;
}): boolean {
  return hasOnlyExplicitlyStoppedPersistedTeamProcessRows(readPersistedTeamProcessRows(input));
}

export function selectActiveOpenCodeRuntimeLaneIds(
  laneIndex: Pick<OpenCodeRuntimeLaneIndex, 'lanes'> | null | undefined
): string[] {
  return Object.entries(laneIndex?.lanes ?? {})
    .filter(([, entry]) => entry.state === 'active')
    .map(([laneId]) => laneId)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveOpenCodeRuntimeLaneCleanupCwd(input: {
  laneId: string;
  config: TeamConfig | null;
  metaMembers: readonly TeamMember[];
  persistedTeamProjectPath: string | null;
}): string | undefined {
  const projectPath = input.config?.projectPath?.trim() || input.persistedTeamProjectPath;
  const memberName = extractOpenCodeRuntimeLaneMemberName(input.laneId);
  if (!memberName) {
    return projectPath || undefined;
  }
  const normalized = memberName.toLowerCase();
  const configMember = input.config?.members?.find(
    (member) => member.name?.trim().toLowerCase() === normalized
  );
  const metaMember = input.metaMembers.find(
    (member) => member.name?.trim().toLowerCase() === normalized
  );
  return metaMember?.cwd?.trim() || configMember?.cwd?.trim() || projectPath || undefined;
}

export function readProcessCommandByPid(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      return (
        listWindowsProcessTableSync()
          .find((row) => row.pid === pid)
          ?.command?.trim() || null
      );
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function tryStopPersistedOpenCodeRuntimePidForStoppedLane(
  input: {
    teamName: string;
    laneId: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  },
  ports: StoppedOpenCodeRuntimeLanePidStopPorts = {
    readProcessCommandByPid,
    isOpenCodeServeCommand,
    killProcessByPid,
    logInfo: () => undefined,
    logWarning: () => undefined,
  }
): StoppedOpenCodeRuntimeLanePidStopResult {
  const persistedMember = Object.values(input.previousLaunchState?.members ?? {}).find(
    (member) => member.providerId === 'opencode' && member.laneId === input.laneId
  );
  if (!persistedMember) {
    return 'no_pid';
  }
  const pid = persistedMember.runtimePid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return 'no_pid';
  }
  const command = ports.readProcessCommandByPid(pid);
  if (!command) {
    return 'no_pid';
  }
  const persistedProcessCommand = (persistedMember as { processCommand?: unknown }).processCommand;
  const expectedCommand =
    typeof persistedProcessCommand === 'string' ? persistedProcessCommand.trim() : '';
  if (!expectedCommand) {
    ports.logWarning(
      `[${input.teamName}] Refusing to stop persisted OpenCode pid ${pid} for lane ${input.laneId}: persisted process command is unavailable.`
    );
    return 'unsafe';
  }
  if (command !== expectedCommand) {
    ports.logWarning(
      `[${input.teamName}] Refusing to stop persisted OpenCode pid ${pid} for lane ${input.laneId}: process command changed.`
    );
    return 'unsafe';
  }
  if (!ports.isOpenCodeServeCommand(command)) {
    ports.logWarning(
      `[${input.teamName}] Refusing to stop persisted OpenCode pid ${pid} for lane ${input.laneId}: process is not opencode serve.`
    );
    return 'unsafe';
  }
  try {
    ports.killProcessByPid(pid);
    ports.logInfo(
      `[${input.teamName}] Killed orphaned OpenCode runtime pid=${pid} for stopped lane ${input.laneId}`
    );
    return 'stopped';
  } catch (error) {
    ports.logWarning(
      `[${input.teamName}] Failed to kill orphaned OpenCode runtime pid=${pid} for stopped lane ${
        input.laneId
      }: ${error instanceof Error ? error.message : String(error)}`
    );
    return 'unsafe';
  }
}

export async function stopOpenCodeRuntimeLanesForStoppedTeam(input: {
  teamName: string;
  teamsBasePath: string;
  ports: StopOpenCodeRuntimeLanesForStoppedTeamPorts;
}): Promise<number> {
  const { ports, teamName, teamsBasePath } = input;
  if (ports.canDeliverToOpenCodeRuntimeForTeam(teamName)) {
    return 0;
  }
  const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName).catch(() => null);
  const activeLaneIds = selectActiveOpenCodeRuntimeLaneIds(laneIndex);
  if (activeLaneIds.length === 0) {
    return 0;
  }

  const adapter = ports.getOpenCodeRuntimeAdapter();
  const previousLaunchState = await ports.readPreviousLaunchState(teamName).catch(() => null);
  const [config, metaMembers] = await Promise.all([
    ports.readConfigForObservation(teamName).catch(() => null),
    ports.readMembersMeta(teamName).catch(() => []),
  ]);
  const evidenceReader = new OpenCodeRuntimeManifestEvidenceReader({
    teamsBasePath,
  });
  let stopped = 0;
  let cleaned = 0;
  for (const laneId of activeLaneIds) {
    const evidence = await evidenceReader.read(teamName, laneId).catch(() => null);
    const expectedRunId = evidence?.activeRunId?.trim() || null;
    if (adapter && expectedRunId) {
      try {
        const result = await adapter.stop({
          runId: expectedRunId,
          laneId,
          teamName,
          cwd: resolveOpenCodeRuntimeLaneCleanupCwd({
            laneId,
            config,
            metaMembers,
            persistedTeamProjectPath: ports.readPersistedTeamProjectPath(teamName),
          }),
          providerId: 'opencode',
          reason: 'cleanup',
          previousLaunchState,
          force: true,
        });
        if (!result.stopped) {
          ports.logWarning(
            `[${teamName}] OpenCode lane ${laneId} did not confirm stop; retaining runtime ownership and storage.`
          );
          continue;
        }
        stopped += 1;
      } catch (error) {
        ports.logWarning(
          `[${teamName}] Failed to stop orphaned OpenCode lane ${laneId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
    } else if (expectedRunId) {
      ports.logWarning(
        `[${teamName}] OpenCode lane ${laneId} belongs to stopped team, but runtime adapter is unavailable.`
      );
      continue;
    } else if (!expectedRunId) {
      const pidStopResult = ports.tryStopPersistedOpenCodeRuntimePidForStoppedLane({
        teamName,
        laneId,
        previousLaunchState,
      });
      if (pidStopResult === 'unsafe') {
        continue;
      }
    }

    const cleared = await clearOpenCodeRuntimeLaneStorage({
      teamsBasePath,
      teamName,
      laneId,
      ...(expectedRunId ? { expectedRunId } : {}),
    }).catch(() => false);
    if (!cleared) {
      ports.logWarning(
        `[${teamName}] OpenCode lane ${laneId} ownership changed before stopped-team storage cleanup; retaining current runtime tracking.`
      );
      continue;
    }
    cleaned += 1;
    ports.deleteSecondaryRuntimeRun(teamName, laneId);
    if (laneId === 'primary') {
      ports.clearPrimaryRuntimeRun(teamName);
    }
  }
  if (cleaned > 0) {
    ports.markStoppedTeamOpenCodeRuntimeLanesCleaned(teamName);
  }
  return stopped;
}
