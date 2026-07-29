/**
 * Stable compatibility facade for callers that still import the legacy teams IPC module.
 * Compatibility state and wiring live in the outer ACL.
 */
import { TeamPermanentDeletionTransactionCoordinator } from '../../features/team-view-read-model/main/adapters/output/TeamPermanentDeletionTransactionCoordinator';
import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';

import {
  initializeTeamAuxiliaryIpc,
  registerTeamAuxiliaryIpc,
  removeTeamAuxiliaryIpc,
} from './teamAuxiliaryIpc';
import {
  initializeLegacyTeamHandlers,
  registerLegacyTeamHandlers,
  removeLegacyTeamHandlers,
} from './teamLegacyAdapters';

import type {
  BranchStatusService,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
} from '../services';
import type { LaunchIoGovernor } from '../services/team/LaunchIoGovernor';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { DesktopTeamRuntimeCapability } from './teamFeatureCapabilities';
import type { TeamPermanentDeletionLifecycle } from './teamLegacyAdapters';
import type { IpcMain } from 'electron';

export { showTeamNativeNotification } from './teamAuxiliaryIpc';
export {
  createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository,
  handleListTeamLifecycle,
  initializeTeamLifecycleReadHandler,
  permanentlyDeleteDraftTeam,
  permanentlyDeleteTeam,
  waitForPendingPermanentDeletionRecoveryForTests,
} from './teamLegacyAdapters';

export function initializeTeamHandlers(
  service: TeamDataService,
  runtimeApi: Pick<DesktopTeamRuntimeCapability, 'stopTeam'>,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  logSourceTracker?: TeamLogSourceTracker,
  branchTracker?: BranchStatusService,
  ioGovernor?: LaunchIoGovernor,
  permanentDeletionLifecycle?: TeamPermanentDeletionLifecycle
): void {
  initializeLegacyTeamHandlers(
    initializeTeamAuxiliaryIpc,
    TeamPermanentDeletionTransactionCoordinator,
    () => ({
      attachmentStore: new TeamAttachmentStore(),
      taskAttachmentStore: new TeamTaskAttachmentStore(),
    }),
    service,
    runtimeApi,
    backupService,
    toolTracker,
    logSourceTracker,
    branchTracker,
    ioGovernor,
    permanentDeletionLifecycle
  );
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  registerLegacyTeamHandlers(ipcMain, registerTeamAuxiliaryIpc);
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  removeLegacyTeamHandlers(ipcMain, removeTeamAuxiliaryIpc);
}
