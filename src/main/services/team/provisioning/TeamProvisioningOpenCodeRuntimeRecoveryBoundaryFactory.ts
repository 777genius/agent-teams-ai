import { getErrorMessage as getDefaultErrorMessage } from '@shared/utils/errorHandling';
import { randomUUID } from 'crypto';

import {
  type OpenCodeRuntimeLaneIndex,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import {
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

type OpenCodeRuntimeRecoveryBoundaryLogger = Pick<Console, 'warn'>;

export interface OpenCodeRuntimeRecoveryActiveInput {
  teamName: string;
  laneId: string;
  member: TeamMember;
  projectPath: string | null;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export interface OpenCodeRuntimeRecoveryMissingInput extends OpenCodeRuntimeRecoveryActiveInput {
  persistedMember: PersistedTeamLaunchMemberState;
}

export interface TeamProvisioningOpenCodeRuntimeRecoveryBoundary {
  tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
    input: OpenCodeRuntimeRecoveryActiveInput
  ): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
    input: OpenCodeRuntimeRecoveryMissingInput
  ): Promise<TeamRuntimeMemberLaunchEvidence | null>;
}

export interface TeamProvisioningOpenCodeRuntimeRecoveryBoundaryPorts {
  teamsBasePath: string;
  logger: OpenCodeRuntimeRecoveryBoundaryLogger;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  createRunId?: () => string;
  readOpenCodeRuntimeLaneIndex?: (
    teamsBasePath: string,
    teamName: string
  ) => Promise<OpenCodeRuntimeLaneIndex>;
  upsertOpenCodeRuntimeLaneIndexEntry?: typeof upsertOpenCodeRuntimeLaneIndexEntry;
  setOpenCodeRuntimeActiveRunManifest?: typeof setOpenCodeRuntimeActiveRunManifest;
  getErrorMessage?: (error: unknown) => string;
}

export function createTeamProvisioningOpenCodeRuntimeRecoveryBoundary(
  ports: TeamProvisioningOpenCodeRuntimeRecoveryBoundaryPorts
): TeamProvisioningOpenCodeRuntimeRecoveryBoundary {
  const createRunId = ports.createRunId ?? randomUUID;
  const readLaneIndex = ports.readOpenCodeRuntimeLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const upsertLaneIndex =
    ports.upsertOpenCodeRuntimeLaneIndexEntry ?? upsertOpenCodeRuntimeLaneIndexEntry;
  const setActiveManifest =
    ports.setOpenCodeRuntimeActiveRunManifest ?? setOpenCodeRuntimeActiveRunManifest;
  const formatError = ports.getErrorMessage ?? getDefaultErrorMessage;

  const boundary: TeamProvisioningOpenCodeRuntimeRecoveryBoundary = {
    async tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
      params
    ): Promise<TeamRuntimeMemberLaunchEvidence | null> {
      const adapter = ports.getOpenCodeRuntimeAdapter();
      const runtimeProjectPath = params.member.cwd?.trim() || params.projectPath;
      if (!adapter || !runtimeProjectPath) {
        return null;
      }

      try {
        const reconcileResult = await adapter.reconcile({
          runId: createRunId(),
          laneId: params.laneId,
          teamName: params.teamName,
          providerId: 'opencode',
          expectedMembers: [
            {
              name: params.member.name,
              role: params.member.role,
              workflow: params.member.workflow,
              isolation: params.member.isolation === 'worktree' ? ('worktree' as const) : undefined,
              providerId: 'opencode',
              model: params.member.model,
              effort: params.member.effort,
              cwd: runtimeProjectPath,
            },
          ],
          previousLaunchState: params.previousLaunchState,
          reason: 'startup_recovery',
        });
        return reconcileResult.members[params.member.name] ?? null;
      } catch (error) {
        ports.logger.warn(
          `[${params.teamName}] Failed to recover stale OpenCode lane ${params.laneId} from runtime bridge: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      }
    },

    async tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
      params
    ): Promise<TeamRuntimeMemberLaunchEvidence | null> {
      const currentLaneIndex = await readLaneIndex(ports.teamsBasePath, params.teamName).catch(
        () => null
      );
      const currentEntry = currentLaneIndex?.lanes[params.laneId];
      if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
        return null;
      }
      if (!isRecoverablePersistedOpenCodeRuntimeCandidate(params.persistedMember)) {
        return null;
      }

      const runtimeEvidence = await boundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName: params.teamName,
        laneId: params.laneId,
        member: params.member,
        projectPath: params.projectPath,
        previousLaunchState: params.previousLaunchState,
      });
      if (!isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
        return null;
      }

      const diagnostics = Array.from(
        new Set([
          'Recovered missing OpenCode runtime lane index from persisted runtime evidence.',
          ...(runtimeEvidence.diagnostics ?? []),
        ])
      );
      await upsertLaneIndex({
        teamsBasePath: ports.teamsBasePath,
        teamName: params.teamName,
        laneId: params.laneId,
        state: 'active',
        diagnostics,
      }).catch((error: unknown) => {
        ports.logger.warn(
          `[${params.teamName}] Failed to recover missing OpenCode lane index ${params.laneId}: ${formatError(error)}`
        );
      });
      await setActiveManifest({
        teamsBasePath: ports.teamsBasePath,
        teamName: params.teamName,
        laneId: params.laneId,
        runId: params.persistedMember.runtimeRunId ?? null,
      }).catch((error: unknown) => {
        ports.logger.warn(
          `[${params.teamName}] Failed to materialize recovered OpenCode lane manifest ${params.laneId}: ${formatError(error)}`
        );
      });

      return {
        ...runtimeEvidence,
        diagnostics,
      };
    },
  };

  return boundary;
}
