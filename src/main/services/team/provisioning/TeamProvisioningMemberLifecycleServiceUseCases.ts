import {
  createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase,
  type HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase,
} from './TeamProvisioningHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase';
import {
  createPersistOpenCodeMemberRestartSystemMessageUseCase,
  type PersistOpenCodeMemberRestartSystemMessageUseCase,
} from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';
import {
  createReadOpenCodeSecondaryRetryOutcomeUseCase,
  type ReadOpenCodeSecondaryRetryOutcomeUseCase,
} from './TeamProvisioningReadOpenCodeSecondaryRetryOutcomeUseCase';
import {
  createNodeResolveDirectRestartRuntimeCwdUseCase,
  type ResolveDirectRestartRuntimeCwdUseCase,
} from './TeamProvisioningResolveDirectRestartRuntimeCwdUseCase';
import {
  createNodeUpdateDirectTmuxRestartMemberConfigUseCase,
  type UpdateDirectTmuxRestartMemberConfigUseCase,
} from './TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';

import type { AppendDirectProcessRuntimeEventUseCase } from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import type {
  TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams,
  TeamProvisioningMemberLifecycleRestartUseCaseSeams,
} from './TeamProvisioningMemberLifecycleUseCaseSeams';
import type { PreparePrimaryOwnedMemberRestartRuntimeUseCase } from './TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { StopPrimaryOwnedRosterRuntimeUseCase } from './TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export interface TeamProvisioningMemberLifecycleServiceUseCasePorts {
  persistSentMessage(teamName: string, message: Record<string, unknown>): void;
  readLaunchStateSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
  stopPrimaryOwnedRosterRuntime: StopPrimaryOwnedRosterRuntimeUseCase;
  preparePrimaryOwnedMemberRestartRuntime: PreparePrimaryOwnedMemberRestartRuntimeUseCase;
  nowIso(): string;
  randomUUID(): string;
}

export interface TeamProvisioningMemberLifecycleServiceUseCases
  extends
    TeamProvisioningMemberLifecycleRestartUseCaseSeams,
    Pick<
      TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams,
      'readOpenCodeSecondaryRetryOutcome' | 'hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch'
    > {
  persistOpenCodeMemberRestartSystemMessage: PersistOpenCodeMemberRestartSystemMessageUseCase;
  readOpenCodeSecondaryRetryOutcome: ReadOpenCodeSecondaryRetryOutcomeUseCase;
  hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch: HasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
  updateDirectTmuxRestartMemberConfig: UpdateDirectTmuxRestartMemberConfigUseCase;
  stopPrimaryOwnedRosterRuntime: StopPrimaryOwnedRosterRuntimeUseCase;
  preparePrimaryOwnedMemberRestartRuntime: PreparePrimaryOwnedMemberRestartRuntimeUseCase;
  resolveDirectRestartRuntimeCwd: ResolveDirectRestartRuntimeCwdUseCase;
}

export function createTeamProvisioningMemberLifecycleServiceUseCases(
  ports: TeamProvisioningMemberLifecycleServiceUseCasePorts
): TeamProvisioningMemberLifecycleServiceUseCases {
  return {
    persistOpenCodeMemberRestartSystemMessage:
      createPersistOpenCodeMemberRestartSystemMessageUseCase({
        persistSentMessage: ports.persistSentMessage,
        nowIso: ports.nowIso,
        randomUUID: ports.randomUUID,
      }),
    readOpenCodeSecondaryRetryOutcome: createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot: ports.readLaunchStateSnapshot,
    }),
    hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch:
      createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase({
        readLaunchStateSnapshot: ports.readLaunchStateSnapshot,
        getLiveTeamAgentRuntimeMetadata: ports.getLiveTeamAgentRuntimeMetadata,
      }),
    appendDirectProcessRuntimeEvent: ports.appendDirectProcessRuntimeEvent,
    updateDirectTmuxRestartMemberConfig: createNodeUpdateDirectTmuxRestartMemberConfigUseCase(),
    stopPrimaryOwnedRosterRuntime: ports.stopPrimaryOwnedRosterRuntime,
    preparePrimaryOwnedMemberRestartRuntime: ports.preparePrimaryOwnedMemberRestartRuntime,
    resolveDirectRestartRuntimeCwd: createNodeResolveDirectRestartRuntimeCwdUseCase(),
  };
}
