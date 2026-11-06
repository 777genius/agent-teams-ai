import { inferTeamProviderIdFromModel, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { MissingOpenCodeRuntimeConfigIdentityError } from './TeamProvisioningRuntimeRecipientResolution';

import type { TeamProvisioningLaunchRosterInput } from './TeamProvisioningLaunchRosterMaterialization';
import type { TeamCreateRequest, TeamMember, TeamProviderId, TeamProvisioningProgress } from '@shared/types';

interface TrackedRecipientRun {
  runId: string;
  teamName: string;
  allEffectiveMembers: TeamCreateRequest['members'];
  cancelRequested: boolean;
  processKilled: boolean;
  progress: Pick<TeamProvisioningProgress, 'state'>;
}

function isTerminalProgress(state: TeamProvisioningProgress['state']): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'disconnected';
}

export interface OpenCodeRecipientIdentityForUserSendPorts {
  resolveProviderId(teamName: string, memberName: string): Promise<TeamProviderId | undefined>;
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TrackedRecipientRun | undefined;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
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

    const runId = ports.getTrackedRunId(teamName);
    const run = runId ? ports.getRun(runId) : undefined;
    const candidates = run?.allEffectiveMembers.filter(
      (member) => member.name.trim().toLowerCase() === memberName.trim().toLowerCase()
    );
    const member = candidates?.length === 1 ? candidates[0] : undefined;
    if (
      !runId ||
      !run ||
      run.runId !== runId ||
      run.teamName !== teamName ||
      run.cancelRequested ||
      run.processKilled ||
      isTerminalProgress(run.progress.state) ||
      member?.providerId !== 'opencode' ||
      !member.model?.trim()
    ) {
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
        inferTeamProviderIdFromModel(meta.model)) !== 'opencode' ||
      (meta.model?.trim() && meta.model.trim() !== member.model.trim())
    ) {
      throw error;
    }

    const isCurrentRun = () =>
      ports.getRun(runId) === run &&
      ports.getTrackedRunId(teamName) === runId &&
      !run.cancelRequested &&
      !run.processKilled &&
      !isTerminalProgress(run.progress.state);
    if (!isCurrentRun()) {
      throw error;
    }

    const published = await ports.materializeLaunchRoster({
      teamName,
      members: [member],
      isCurrentRun,
    });
    if (!published) {
      throw error;
    }

    // Re-resolve from the authoritative config. Never synthesize a successful
    // recipient route from metadata or a provisional write result.
    return await resolve();
  }
}
