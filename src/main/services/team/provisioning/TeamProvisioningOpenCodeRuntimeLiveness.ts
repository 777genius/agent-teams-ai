import { isLeadMember } from '@shared/utils/leadDetection';

import { type RuntimeEvidenceKind } from '../opencode/store/RuntimeRunTombstoneStore';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import { shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange } from './TeamProvisioningOpenCodeRuntimeLivenessPolicy';
import { resolvePersistedRuntimeMemberIdentity } from './TeamProvisioningPersistedRuntimeMemberIdentity';
import {
  buildRuntimeToolMetadataDiagnostics,
  mergeRuntimeDiagnostics,
  normalizeRuntimeStringArray,
  type RuntimeToolMetadata,
} from './TeamProvisioningRuntimeMetadata';

import type {
  OpenCodeRuntimeCheckinPorts,
  OpenCodeRuntimeCheckinRun,
} from './TeamProvisioningOpenCodeRuntimeCheckinPorts';
import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface OpenCodeRuntimeLivenessInput {
  teamName: string;
  runId: string;
  memberName: string;
  runtimeSessionId: string;
  observedAt: string;
  diagnostics: unknown;
  metadata?: RuntimeToolMetadata;
  reason: string;
  requiredIdentity?: {
    laneId: string;
    evidenceKind: RuntimeEvidenceKind;
  };
}

export function buildOpenCodeRuntimeMemberLivenessSnapshot<Run extends OpenCodeRuntimeCheckinRun>(
  input: OpenCodeRuntimeLivenessInput,
  previous: PersistedTeamLaunchSnapshot | null,
  ports: Pick<OpenCodeRuntimeCheckinPorts<Run>, 'getTrackedRun' | 'readPersistedRuntimeMembers'>
): { snapshot: PersistedTeamLaunchSnapshot; shouldEmitMemberSpawnChange: boolean } {
  const expectedMembers = previous
    ? getPersistedLaunchMemberNames(previous)
    : ports
        .readPersistedRuntimeMembers(input.teamName)
        .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
        .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }));
  const previousMember = previous?.members[input.memberName];
  const previousRuntimeRunId =
    typeof previousMember?.runtimeRunId === 'string' ? previousMember.runtimeRunId.trim() : '';
  const sameRuntimeRun = previousRuntimeRunId.length > 0 && previousRuntimeRunId === input.runId;
  const shouldEmitMemberSpawnChange = shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
    previousMember,
    runtimeRunId: input.runId,
    runtimeSessionId: input.runtimeSessionId,
    runtimePid: input.metadata?.runtimePid,
  });
  const runtimePid =
    input.metadata?.runtimePid ?? (sameRuntimeRun ? previousMember?.runtimePid : undefined);
  const pidSource = input.metadata?.runtimePid
    ? ('runtime_bootstrap' as const)
    : sameRuntimeRun
      ? previousMember?.pidSource
      : undefined;
  const persistedIdentity = resolvePersistedRuntimeMemberIdentity({
    memberName: input.memberName,
    previousMember,
    trackedRun: ports.getTrackedRun(input.teamName),
  });
  const nextMember: PersistedTeamLaunchMemberState = {
    ...persistedIdentity,
    ...(previousMember ?? {}),
    name: input.memberName,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    bootstrapStalled: undefined,
    runtimePid,
    runtimeRunId: input.runId,
    runtimeSessionId: input.runtimeSessionId,
    livenessKind: 'confirmed_bootstrap',
    pidSource,
    runtimeDiagnostic: input.reason,
    runtimeDiagnosticSeverity: 'info',
    runtimeLastSeenAt: input.observedAt,
    firstSpawnAcceptedAt: previousMember?.firstSpawnAcceptedAt ?? input.observedAt,
    lastHeartbeatAt: input.observedAt,
    lastRuntimeAliveAt: input.observedAt,
    lastEvaluatedAt: input.observedAt,
    sources: {
      ...(previousMember?.sources ?? {}),
      nativeHeartbeat: true,
      processAlive: true,
    },
    diagnostics: mergeRuntimeDiagnostics(
      previousMember?.diagnostics,
      [
        ...normalizeRuntimeStringArray(input.diagnostics),
        ...buildRuntimeToolMetadataDiagnostics(input.metadata),
      ],
      input.reason
    ),
  };
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    expectedMembers: [...new Set([...expectedMembers, input.memberName])],
    leadSessionId: previous?.leadSessionId,
    launchPhase: previous?.launchPhase ?? 'active',
    members: {
      ...(previous?.members ?? {}),
      [input.memberName]: nextMember,
    },
    updatedAt: input.observedAt,
  });
  return { snapshot, shouldEmitMemberSpawnChange };
}
