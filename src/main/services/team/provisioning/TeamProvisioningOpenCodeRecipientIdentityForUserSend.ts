import { inferTeamProviderIdFromModel, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { MissingOpenCodeRuntimeConfigIdentityError } from './TeamProvisioningRuntimeRecipientResolution';

import type { TeamProvisioningLaunchRosterInput } from './TeamProvisioningLaunchRosterMaterialization';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest, TeamMember, TeamProviderId, TeamProvisioningProgress } from '@shared/types';

interface TrackedRecipientRun {
  runId: string;
  teamName: string;
  allEffectiveMembers: TeamCreateRequest['members'];
  cancelRequested: boolean;
  processKilled: boolean;
  progress: Pick<TeamProvisioningProgress, 'state'>;
}

interface DurableRecipient {
  member: TeamCreateRequest['members'][number];
  isCurrentRun(): boolean;
  beforeCommit(currentMeta: readonly TeamMember[]): Promise<boolean>;
}

function findPersistedRecipient(
  snapshot: PersistedTeamLaunchSnapshot | null,
  memberName: string
): PersistedTeamLaunchSnapshot['members'][string] | null {
  if (!snapshot?.publicationRunId?.trim()) return null;
  const normalized = memberName.trim().toLowerCase();
  if (snapshot.expectedMembers.filter((name) => name.trim().toLowerCase() === normalized).length !== 1) {
    return null;
  }
  const matches = Object.values(snapshot.members).filter(
    (member) => member.name.trim().toLowerCase() === normalized
  );
  return matches.length === 1 ? matches[0] : null;
}

/** A persisted lane may survive the desktop process, but metadata alone is never launch proof. */
async function verifyDurableRecipient(
  teamName: string,
  memberName: string,
  meta: TeamMember,
  ports: OpenCodeRecipientIdentityForUserSendPorts
): Promise<DurableRecipient | null> {
  const stopEpoch = ports.getStopEpoch(teamName);
  const model = meta.model?.trim();
  if (
    !model ||
    !(await ports.isTeamOwned(teamName)) ||
    (await ports.isTeamStopped(teamName)) ||
    !ports.isRuntimeReachable(teamName)
  ) {
    return null;
  }
  const snapshot = await ports.readPersistedLaunchState(teamName);
  const recipient = findPersistedRecipient(snapshot, memberName);
  const laneId = recipient?.laneId?.trim();
  const runId = recipient?.runtimeRunId?.trim();
  const sessionId = recipient?.runtimeSessionId?.trim();
  if (
    snapshot?.teamName !== teamName ||
    recipient?.providerId !== 'opencode' ||
    recipient.model?.trim() !== model ||
    recipient.launchState !== 'confirmed_alive' ||
    !recipient.runtimeAlive ||
    !recipient.bootstrapConfirmed ||
    recipient.hardFailure ||
    !laneId ||
    !runId ||
    !sessionId
  ) {
    return null;
  }

  const verifiedMember = { ...meta, providerId: 'opencode' as const, model };
  const isCurrentRun = () =>
    ports.getTrackedRunId(teamName) === null &&
    ports.getStopEpoch(teamName) === stopEpoch &&
    ports.isRuntimeReachable(teamName);
  const beforeCommit = async (currentMeta: readonly TeamMember[]) => {
    const matches = currentMeta.filter(
      (candidate) => candidate.name.trim().toLowerCase() === memberName.trim().toLowerCase()
    );
    const currentMember = matches.length === 1 ? matches[0] : undefined;
    if (
      !currentMember ||
      currentMember.removedAt != null ||
      (normalizeOptionalTeamProviderId(currentMember.providerId) ??
        inferTeamProviderIdFromModel(currentMember.model)) !== 'opencode' ||
      currentMember.model?.trim() !== model ||
      currentMember.providerBackendId !== verifiedMember.providerBackendId ||
      currentMember.cwd?.trim() !== verifiedMember.cwd?.trim()
    ) {
      return false;
    }
    if (
      !isCurrentRun() ||
      !(await ports.isTeamOwned(teamName)) ||
      (await ports.isTeamStopped(teamName))
    ) {
      return false;
    }
    const latest = await ports.readPersistedLaunchState(teamName);
    const current = findPersistedRecipient(latest, memberName);
    return (
      latest?.teamName === teamName &&
      latest.publicationRunId === snapshot.publicationRunId &&
      current?.providerId === 'opencode' &&
      current.model?.trim() === model &&
      current.runtimeRunId === runId &&
      current.runtimeSessionId === sessionId &&
      current.laneId === laneId &&
      current.launchState === 'confirmed_alive' &&
      current.runtimeAlive === true &&
      current.bootstrapConfirmed === true &&
      current.hardFailure === false &&
      (await ports.resolveActiveLaneRunId(teamName, laneId)) === runId &&
      (await ports.hasCommittedRecipientSession({
        teamName,
        memberName,
        laneId,
        runId,
        runtimeSessionId: sessionId,
      })) &&
      isCurrentRun()
    );
  };
  if (!(await beforeCommit([meta]))) return null;
  return {
    member: verifiedMember,
    isCurrentRun,
    beforeCommit,
  };
}

export interface OpenCodeRecipientIdentityForUserSendPorts {
  resolveProviderId(teamName: string, memberName: string): Promise<TeamProviderId | undefined>;
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TrackedRecipientRun | undefined;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
  readPersistedLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  isTeamOwned(teamName: string): Promise<boolean>;
  isTeamStopped(teamName: string): Promise<boolean>;
  isRuntimeReachable(teamName: string): boolean;
  resolveActiveLaneRunId(teamName: string, laneId: string): Promise<string | null>;
  hasCommittedRecipientSession(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    runId: string;
    runtimeSessionId: string;
  }): Promise<boolean>;
  getStopEpoch(teamName: string): string;
  materializeLaunchRoster(input: TeamProvisioningLaunchRosterInput): Promise<boolean>;
}

/**
 * Explicit message-send command: repair only a member owned by this exact live
 * runtime run, then ask the read-only recipient query to verify the committed
 * config. Status queries and background observation must never write config.
 */
export async function resolveOpenCodeRecipientIdentityForUserSend(
  input: { teamName: string; memberName: string },
  ports: OpenCodeRecipientIdentityForUserSendPorts
): Promise<TeamProviderId | undefined> {
  const { teamName, memberName } = input;
  const resolve = () => ports.resolveProviderId(teamName, memberName);

  try {
    return await resolve();
  } catch (error) {
    if (!(error instanceof MissingOpenCodeRuntimeConfigIdentityError)) {
      throw error;
    }

    const matches = (await ports.readMetaMembers(teamName)).filter(
      (candidate) => candidate.name.trim().toLowerCase() === memberName.trim().toLowerCase()
    );
    const meta = matches.length === 1 ? matches[0] : undefined;
    if (
      !meta ||
      meta.removedAt != null ||
      (normalizeOptionalTeamProviderId(meta.providerId) ??
        inferTeamProviderIdFromModel(meta.model)) !== 'opencode'
    ) {
      throw error;
    }

    const runId = ports.getTrackedRunId(teamName);
    const run = runId ? ports.getRun(runId) : undefined;
    let recovery: DurableRecipient | null;
    if (runId) {
      const candidates = run?.allEffectiveMembers.filter(
        (member) => member.name.trim().toLowerCase() === memberName.trim().toLowerCase()
      );
      const member = candidates?.length === 1 ? candidates[0] : undefined;
      if (
        !run ||
        run.runId !== runId ||
        run.teamName !== teamName ||
        run.cancelRequested ||
        run.processKilled ||
        run.progress.state !== 'ready' ||
        member?.providerId !== 'opencode' ||
        !member.model?.trim() ||
        (meta.model?.trim() && meta.model.trim() !== member.model.trim())
      ) {
        throw error;
      }
      recovery = {
        member,
        isCurrentRun: () =>
          ports.getRun(runId) === run &&
          ports.getTrackedRunId(teamName) === runId &&
          !run.cancelRequested &&
          !run.processKilled &&
          run.progress.state === 'ready',
        beforeCommit: async () => true,
      };
    } else {
      recovery = await verifyDurableRecipient(teamName, memberName, meta, ports);
    }
    if (!recovery?.isCurrentRun()) throw error;

    const published = await ports.materializeLaunchRoster({
      teamName,
      members: [recovery.member],
      isCurrentRun: recovery.isCurrentRun,
      ...(runId ? {} : { beforeCommit: recovery.beforeCommit }),
    });
    if (!published) {
      throw error;
    }

    // Re-resolve from the authoritative config. Never synthesize a successful
    // recipient route from metadata or a provisional write result.
    return await resolve();
  }
}
