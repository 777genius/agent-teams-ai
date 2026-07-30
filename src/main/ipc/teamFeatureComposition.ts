import {
  registerTaskLogObservabilityIpc,
  removeTaskLogObservabilityIpc,
} from '@features/task-log-observability/main';
import { registerTeamApprovalsIpc, removeTeamApprovalsIpc } from '@features/team-approvals/main';
import {
  registerTeamConfigurationIpc,
  removeTeamConfigurationIpc,
} from '@features/team-configuration/main';
import {
  registerTeamLifecycleIpc,
  registerTeamLifecycleReadIpc,
  removeTeamLifecycleIpc,
  removeTeamLifecycleReadIpc,
} from '@features/team-lifecycle/main';
import {
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
  type TeamMessageDeliveryIpcMainPort,
} from '@features/team-message-delivery/main';
import {
  registerTeamProvisioningIpc,
  removeTeamProvisioningIpc,
} from '@features/team-provisioning/main';
import {
  registerTeamRosterMutationIpc,
  removeTeamRosterMutationIpc,
} from '@features/team-roster-mutations/main';
import {
  registerTeamRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc,
} from '@features/team-runtime-operations/main';
import { registerTeamTaskBoardIpc, removeTeamTaskBoardIpc } from '@features/team-task-board/main';
import {
  registerTeamViewReadModelIpc,
  removeTeamViewReadModelIpc,
} from '@features/team-view-read-model/main';

import {
  createDesktopTeamLegacyAdapters,
  type DesktopTeamLegacyAdapterDependencies,
  registerLegacyTeamProcessIpc,
  removeLegacyTeamProcessIpc,
} from './teamLegacyAdapters';
import {
  createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository,
  handleListTeamLifecycle,
  initializeTeamHandlers,
  permanentlyDeleteDraftTeam,
  permanentlyDeleteTeam,
  registerTeamHandlers,
  removeTeamHandlers,
} from './teams';

import type { IpcMain } from 'electron';

export type DesktopTeamFeatureCompositionDependencies = DesktopTeamLegacyAdapterDependencies;

export interface DesktopTeamFeatureComposition {
  initializeLegacyHandlers(): void;
  register(ipcMain: IpcMain): void;
}

export function createDesktopTeamFeatureComposition(
  dependencies: DesktopTeamFeatureCompositionDependencies
): DesktopTeamFeatureComposition {
  const adapters = createDesktopTeamLegacyAdapters(dependencies, {
    createIdentityFencedProvisioningStart,
    createIdentityFencedTeamConfigurationRepository,
    handleListTeamLifecycle: (request) => handleListTeamLifecycle(request),
    permanentlyDeleteDraftTeam,
    permanentlyDeleteTeam,
  });

  return {
    initializeLegacyHandlers(): void {
      initializeTeamHandlers(
        dependencies.teamDataService,
        dependencies.capabilities.runtime,
        dependencies.teamBackupService,
        dependencies.teammateToolTracker,
        dependencies.teamLogSourceTracker,
        dependencies.branchStatusService,
        dependencies.launchIoGovernor,
        dependencies.teamPermanentDeletionLifecycle
      );
    },
    register(ipcMain: IpcMain): void {
      registerTeamHandlers(ipcMain);
      registerTeamLifecycleReadIpc(ipcMain, adapters.lifecycleRead);
      registerTeamLifecycleIpc(ipcMain, adapters.lifecycle);
      registerTeamRuntimeOperationsIpc(ipcMain, adapters.runtimeOperations);
      registerTeamProvisioningIpc(ipcMain, adapters.provisioning);
      registerTeamConfigurationIpc(ipcMain, adapters.configuration);
      registerTeamMessageDeliveryIpc(
        createTeamMessageDeliveryIpcMainPort(ipcMain),
        adapters.messageDelivery
      );
      registerLegacyTeamProcessIpc(ipcMain, adapters.legacyProcess);
      registerTeamRosterMutationIpc(ipcMain, adapters.rosterMutation);
      registerTeamViewReadModelIpc(ipcMain, adapters.viewReadModel);
      registerTeamTaskBoardIpc(ipcMain, adapters.taskBoard);
      registerTeamApprovalsIpc(ipcMain, adapters.approvals);
      registerTaskLogObservabilityIpc(ipcMain, adapters.taskLogObservability);
    },
  };
}

export function removeDesktopTeamFeatureComposition(ipcMain: IpcMain): void {
  removeTeamHandlers(ipcMain);
  removeTeamLifecycleReadIpc(ipcMain);
  removeTeamLifecycleIpc(ipcMain);
  removeTeamRuntimeOperationsIpc(ipcMain);
  removeTeamProvisioningIpc(ipcMain);
  removeTeamConfigurationIpc(ipcMain);
  removeTeamMessageDeliveryIpc(createTeamMessageDeliveryIpcMainPort(ipcMain));
  removeLegacyTeamProcessIpc(ipcMain);
  removeTeamRosterMutationIpc(ipcMain);
  removeTeamViewReadModelIpc(ipcMain);
  removeTeamTaskBoardIpc(ipcMain);
  removeTeamApprovalsIpc(ipcMain);
  removeTaskLogObservabilityIpc(ipcMain);
}

function createTeamMessageDeliveryIpcMainPort(ipcMain: IpcMain): TeamMessageDeliveryIpcMainPort {
  return {
    handle: (channel, listener) => {
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args));
    },
    removeHandler: (channel) => {
      ipcMain.removeHandler(channel);
    },
  };
}
