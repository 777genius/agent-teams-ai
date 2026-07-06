import {
  createPersistOpenCodeMemberRestartSystemMessageUseCase,
  type PersistOpenCodeMemberRestartSystemMessageUseCase,
} from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';

import type { AppendDirectProcessRuntimeEventUseCase } from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';

export interface TeamProvisioningMemberLifecycleServiceUseCasePorts {
  persistSentMessage(teamName: string, message: Record<string, unknown>): void;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
  nowIso(): string;
  randomUUID(): string;
}

export interface TeamProvisioningMemberLifecycleServiceUseCases {
  persistOpenCodeMemberRestartSystemMessage: PersistOpenCodeMemberRestartSystemMessageUseCase;
  appendDirectProcessRuntimeEvent: AppendDirectProcessRuntimeEventUseCase;
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
  };
}
