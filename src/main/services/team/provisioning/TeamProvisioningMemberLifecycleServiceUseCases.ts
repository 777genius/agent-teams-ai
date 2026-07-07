import {
  createPersistOpenCodeMemberRestartSystemMessageUseCase,
  type PersistOpenCodeMemberRestartSystemMessageUseCase,
} from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';

import type { AppendDirectProcessRuntimeEventUseCase } from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import type { PreparePrimaryOwnedMemberRestartRuntimeUseCase } from './TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import type { StopPrimaryOwnedRosterRuntimeUseCase } from './TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';

export interface TeamProvisioningMemberLifecycleServiceUseCasePorts {
  persistSentMessage(teamName: string, message: Record<string, unknown>): void;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
  stopPrimaryOwnedRosterRuntime: StopPrimaryOwnedRosterRuntimeUseCase;
  preparePrimaryOwnedMemberRestartRuntime: PreparePrimaryOwnedMemberRestartRuntimeUseCase;
  nowIso(): string;
  randomUUID(): string;
}

export interface TeamProvisioningMemberLifecycleServiceUseCases {
  persistOpenCodeMemberRestartSystemMessage: PersistOpenCodeMemberRestartSystemMessageUseCase;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
  stopPrimaryOwnedRosterRuntime: StopPrimaryOwnedRosterRuntimeUseCase;
  preparePrimaryOwnedMemberRestartRuntime: PreparePrimaryOwnedMemberRestartRuntimeUseCase;
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
    appendDirectProcessRuntimeEvent: ports.appendDirectProcessRuntimeEvent,
    stopPrimaryOwnedRosterRuntime: ports.stopPrimaryOwnedRosterRuntime,
    preparePrimaryOwnedMemberRestartRuntime: ports.preparePrimaryOwnedMemberRestartRuntime,
  };
}
