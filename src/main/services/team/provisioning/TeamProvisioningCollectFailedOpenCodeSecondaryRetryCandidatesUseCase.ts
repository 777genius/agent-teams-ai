import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { type TeamMembersMetaStore } from '../TeamMembersMetaStore';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamCreateRequest,
} from '@shared/types';

type EffectiveConfiguredMember = TeamCreateRequest['members'][number] & {
  agentType?: string;
  removedAt?: number | string;
};
type MetaMembers = Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>;

interface OpenCodeSecondaryRetryRunLane {
  laneId: string;
  member: TeamCreateRequest['members'][number];
  state: 'queued' | 'launching' | 'finished';
}

export interface OpenCodeSecondaryRetryRun {
  teamName: string;
  request: Pick<TeamCreateRequest, 'providerId'>;
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  mixedSecondaryLanes?: readonly OpenCodeSecondaryRetryRunLane[];
}

export interface OpenCodeSecondaryRetryCandidate {
  memberName: string;
  laneId: string;
}

export interface CollectFailedOpenCodeSecondaryRetryCandidatesPorts {
  hasOpenCodeRuntimeAdapter(): boolean;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<MetaMembers>;
  readLaunchStateSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  resolveEffectiveConfiguredMember(
    configMembers: TeamConfig['members'],
    metaMembers: MetaMembers,
    memberName: string
  ): EffectiveConfiguredMember | null;
}

export type CollectFailedOpenCodeSecondaryRetryCandidatesUseCase = (
  run: OpenCodeSecondaryRetryRun
) => Promise<OpenCodeSecondaryRetryCandidate[]>;

export function createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase(
  ports: CollectFailedOpenCodeSecondaryRetryCandidatesPorts
): CollectFailedOpenCodeSecondaryRetryCandidatesUseCase {
  return async (run) => {
    const teamName = run.teamName;
    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    const isOpenCodeAggregateRun =
      leadProviderId === 'opencode' && (run.mixedSecondaryLanes?.length ?? 0) > 0;
    if (leadProviderId === 'opencode' && !isOpenCodeAggregateRun) {
      throw new Error(
        'Retrying OpenCode secondary lanes requires an active OpenCode worktree lane run.'
      );
    }
    if (!ports.hasOpenCodeRuntimeAdapter()) {
      throw new Error('OpenCode runtime adapter is not available for secondary lane retry.');
    }

    const config = await ports.readConfigForStrictDecision(teamName);
    if (!config) {
      throw new Error(`Team "${teamName}" configuration is no longer available`);
    }
    const metaMembers = await ports.readMetaMembers(teamName).catch(() => []);
    const persistedSnapshot = await ports.readLaunchStateSnapshot(teamName).catch(() => null);

    const names = new Set<string>();
    for (const member of config.members ?? []) {
      const name = member.name?.trim();
      if (name) {
        names.add(name);
      }
    }
    for (const member of metaMembers) {
      const name = member.name?.trim();
      if (name) {
        names.add(name);
      }
    }
    for (const lane of run.mixedSecondaryLanes ?? []) {
      const name = lane.member.name?.trim();
      if (name) {
        names.add(name);
      }
    }
    for (const name of persistedSnapshot?.expectedMembers ?? []) {
      if (name.trim()) {
        names.add(name.trim());
      }
    }
    for (const name of Object.keys(persistedSnapshot?.members ?? {})) {
      if (name.trim()) {
        names.add(name.trim());
      }
    }

    const candidates: OpenCodeSecondaryRetryCandidate[] = [];
    for (const memberName of [...names].sort((left, right) => left.localeCompare(right))) {
      const configuredMember = ports.resolveEffectiveConfiguredMember(
        config.members ?? [],
        metaMembers,
        memberName
      );
      if (!configuredMember || configuredMember.removedAt) {
        continue;
      }
      if (isLeadMember({ name: memberName, agentType: configuredMember.agentType })) {
        continue;
      }
      const desiredProviderId =
        normalizeOptionalTeamProviderId(configuredMember.providerId) ?? leadProviderId;
      if (desiredProviderId !== 'opencode') {
        continue;
      }

      const existingLane = (run.mixedSecondaryLanes ?? []).find((lane) =>
        matchesTeamMemberIdentity(lane.member.name, memberName)
      );
      const liveEntry = run.memberSpawnStatuses.get(memberName);
      const persistedMemberByName =
        persistedSnapshot?.members[memberName] ??
        Object.values(persistedSnapshot?.members ?? {}).find((member) =>
          matchesTeamMemberIdentity(member.name, memberName)
        );
      let laneId: string | null = null;
      if (leadProviderId === 'opencode') {
        const persistedLaneId = persistedMemberByName?.laneId?.startsWith('secondary:opencode:')
          ? persistedMemberByName.laneId
          : null;
        laneId = existingLane?.laneId ?? persistedLaneId;
        if (!laneId) {
          continue;
        }
      } else {
        const laneIdentity = buildPlannedMemberLaneIdentity({
          leadProviderId,
          member: {
            name: memberName,
            providerId: 'opencode',
          },
        });
        if (
          laneIdentity.laneKind !== 'secondary' ||
          laneIdentity.laneOwnerProviderId !== 'opencode'
        ) {
          continue;
        }
        laneId = laneIdentity.laneId;
      }
      const persistedMember =
        persistedMemberByName ??
        Object.values(persistedSnapshot?.members ?? {}).find((member) => member.laneId === laneId);

      if (
        isRetryableFailedOpenCodeSecondaryLane({
          liveEntry,
          persistedMember,
          existingLane,
        })
      ) {
        candidates.push({ memberName, laneId });
      }
    }
    return candidates;
  };
}

export function isRetryableFailedOpenCodeSecondaryLane(input: {
  liveEntry?: MemberSpawnStatusEntry;
  persistedMember?: PersistedTeamLaunchMemberState;
  existingLane?: OpenCodeSecondaryRetryRunLane;
}): boolean {
  const { liveEntry, persistedMember, existingLane } = input;
  if (existingLane?.state === 'queued' || existingLane?.state === 'launching') {
    return false;
  }
  if (
    liveEntry?.launchState === 'skipped_for_launch' ||
    liveEntry?.skippedForLaunch === true ||
    persistedMember?.launchState === 'skipped_for_launch' ||
    persistedMember?.skippedForLaunch === true
  ) {
    return false;
  }
  if (
    liveEntry?.launchState === 'runtime_pending_permission' ||
    liveEntry?.launchState === 'runtime_pending_bootstrap' ||
    persistedMember?.launchState === 'runtime_pending_permission' ||
    persistedMember?.launchState === 'runtime_pending_bootstrap' ||
    (liveEntry?.pendingPermissionRequestIds?.length ?? 0) > 0 ||
    (persistedMember?.pendingPermissionRequestIds?.length ?? 0) > 0
  ) {
    return false;
  }
  if (liveEntry?.launchState === 'starting' || liveEntry?.status === 'spawning') {
    return false;
  }
  if (
    liveEntry?.launchState === 'confirmed_alive' ||
    liveEntry?.bootstrapConfirmed === true ||
    persistedMember?.launchState === 'confirmed_alive' ||
    persistedMember?.bootstrapConfirmed === true
  ) {
    return false;
  }

  return (
    liveEntry?.launchState === 'failed_to_start' ||
    liveEntry?.status === 'error' ||
    persistedMember?.launchState === 'failed_to_start' ||
    persistedMember?.hardFailure === true
  );
}
