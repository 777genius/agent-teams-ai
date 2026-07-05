import { getErrorMessage } from '@shared/utils/errorHandling';

import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import { isPersistedOpenCodeSecondaryLaneMember } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import { findPersistedLaunchMemberForLane } from './TeamProvisioningOpenCodeRuntimePermissions';
import {
  mergeRuntimeDiagnostics,
  normalizeRuntimePositiveInteger,
} from './TeamProvisioningRuntimeMetadata';

import type { PersistedTeamLaunchSnapshot, TeamChangeEvent } from '@shared/types';

export interface RememberOpenCodeRuntimePidFromBridgeInput {
  teamName: string;
  memberName: string;
  laneId: string;
  runId?: string | null;
  runtimeSessionId?: string | null;
  runtimePid?: number;
  reason: string;
}

export interface RememberOpenCodeRuntimePidFromBridgePorts {
  nowIso: () => string;
  readProcessCommandByPid: (pid: number) => string | null | undefined;
  isOpenCodeServeCommand: (command: string) => boolean;
  enqueueLaunchStateStoreOperation: <T>(
    teamName: string,
    operation: () => Promise<T>
  ) => Promise<T>;
  readLaunchState: (teamName: string) => Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot: (
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ) => Promise<void>;
  invalidateRuntimeSnapshotCaches: (teamName: string) => void;
  emitTeamChange: (event: TeamChangeEvent) => void;
  logDebug: (message: string) => void;
}

export async function rememberOpenCodeRuntimePidFromBridge(
  input: RememberOpenCodeRuntimePidFromBridgeInput,
  ports: RememberOpenCodeRuntimePidFromBridgePorts
): Promise<void> {
  const runtimePid = normalizeRuntimePositiveInteger(input.runtimePid);
  if (!runtimePid) {
    return;
  }

  const command = ports.readProcessCommandByPid(runtimePid);
  if (!command || !ports.isOpenCodeServeCommand(command)) {
    ports.logDebug(
      `[${input.teamName}] Ignoring OpenCode bridge runtime pid ${runtimePid} for ${input.memberName}: process identity is not an active opencode serve host.`
    );
    return;
  }

  const observedAt = ports.nowIso();
  try {
    const changed = await ports.enqueueLaunchStateStoreOperation(input.teamName, async () => {
      const previous = await ports.readLaunchState(input.teamName).catch(() => null);
      const previousEntry = findPersistedLaunchMemberForLane({
        previousLaunchState: previous,
        laneId: input.laneId,
        memberName: input.memberName,
        runId: input.runId,
      });
      if (!previous || !previousEntry) {
        return false;
      }
      const previousMember = previousEntry.member;
      if (!isPersistedOpenCodeSecondaryLaneMember(previousMember)) {
        return false;
      }
      if (previousMember.laneId && previousMember.laneId !== input.laneId) {
        return false;
      }
      const previousRunId = previousMember.runtimeRunId?.trim();
      const incomingRunId = input.runId?.trim();
      if (previousRunId && incomingRunId && previousRunId !== incomingRunId) {
        return false;
      }
      const previousSessionId = previousMember.runtimeSessionId?.trim();
      const incomingSessionId = input.runtimeSessionId?.trim();
      if (previousSessionId && incomingSessionId && previousSessionId !== incomingSessionId) {
        return false;
      }
      if (
        previousMember.runtimePid === runtimePid &&
        previousMember.pidSource === 'opencode_bridge'
      ) {
        return false;
      }

      const nextMember = {
        ...previousMember,
        runtimePid,
        ...(incomingRunId ? { runtimeRunId: incomingRunId } : {}),
        ...(incomingSessionId ? { runtimeSessionId: incomingSessionId } : {}),
        pidSource: 'opencode_bridge' as const,
        lastRuntimeAliveAt: observedAt,
        lastEvaluatedAt: observedAt,
        sources: {
          ...(previousMember.sources ?? {}),
          processAlive: true,
        },
        diagnostics: mergeRuntimeDiagnostics(
          previousMember.diagnostics,
          [`runtime pid: ${runtimePid}`, input.reason],
          previousMember.runtimeDiagnostic
        ),
      };
      const nextSnapshot = createPersistedLaunchSnapshot({
        teamName: previous.teamName,
        expectedMembers: previous.expectedMembers,
        bootstrapExpectedMembers: previous.bootstrapExpectedMembers,
        leadSessionId: previous.leadSessionId,
        launchPhase: previous.launchPhase,
        members: {
          ...previous.members,
          [previousEntry.key]: nextMember,
        },
        updatedAt: observedAt,
      });
      await ports.writeLaunchStateSnapshot(input.teamName, nextSnapshot);
      return true;
    });
    if (changed) {
      ports.invalidateRuntimeSnapshotCaches(input.teamName);
      ports.emitTeamChange({
        type: 'member-spawn',
        teamName: input.teamName,
        ...(input.runId ? { runId: input.runId } : {}),
        detail: input.memberName,
      });
    }
  } catch (error) {
    ports.logDebug(
      `[${input.teamName}] Failed to persist OpenCode bridge runtime pid ${runtimePid} for ${input.memberName}: ${getErrorMessage(error)}`
    );
  }
}
