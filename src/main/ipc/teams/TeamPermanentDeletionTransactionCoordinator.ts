import type { TeamAttachmentStore } from '../../services/team/TeamAttachmentStore';
import type {
  TeamBackupService,
  TeamPermanentDeletionIntent,
} from '../../services/team/TeamBackupService';
import type { TeamTaskAttachmentStore } from '../../services/team/TeamTaskAttachmentStore';
import type { DurablePathRemovalProofHooks } from '../../utils/atomicWrite';

interface TeamPermanentDeletionDataPort {
  permanentlyDeleteTeam(
    teamName: string,
    validateTeamDataDetached?: (detachedPath?: string) => Promise<boolean>,
    validateTaskDataDetached?: (detachedPath?: string) => Promise<boolean>,
    options?: {
      skipTeamData?: boolean;
      skipTaskData?: boolean;
      teamDataProofHooks?: DurablePathRemovalProofHooks;
      taskDataProofHooks?: DurablePathRemovalProofHooks;
    }
  ): Promise<boolean | void>;
}

interface TeamPermanentDeletionLifecycle {
  prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
}

export interface TeamPermanentDeletionTransactionCoordinatorPorts {
  backupService(): TeamBackupService | null;
  dataService(): TeamPermanentDeletionDataPort;
  attachmentStore: TeamAttachmentStore;
  taskAttachmentStore: TeamTaskAttachmentStore;
  lifecycle(): TeamPermanentDeletionLifecycle | null;
  invalidateTeamConfig(teamName: string): void;
  logRecoveryError(teamName: string, error: unknown): void;
}

export class TeamPermanentDeletionTransactionCoordinator {
  private readonly operations = new Map<string, Promise<unknown>>();
  private recoveryPromise: Promise<void> = Promise.resolve();

  constructor(private readonly ports: TeamPermanentDeletionTransactionCoordinatorPorts) {}

  startRecovery(): void {
    this.recoveryPromise = this.recoverPending().catch((error: unknown) => {
      this.ports.logRecoveryError('startup', error);
    });
  }

  async waitForRecovery(): Promise<void> {
    await this.recoveryPromise;
  }

  async permanentlyDelete(
    teamName: string,
    options: { draft?: boolean; existingIntent?: TeamPermanentDeletionIntent } = {}
  ): Promise<void> {
    await this.withOperation(teamName, async () => {
      const backupService = this.getBackupService();
      let intent =
        options.existingIntent ??
        (await backupService.beginPermanentDeletion(teamName, { draft: options.draft }));
      let crossedDestructiveBoundary = intent.phase === 'deleting';
      try {
        if (!crossedDestructiveBoundary) {
          intent = await backupService.commitPermanentDeletionBoundary(intent);
          crossedDestructiveBoundary = true;
        }
        await this.runCleanup(intent);
      } catch (error) {
        if (!crossedDestructiveBoundary) {
          await backupService.abortPreparedPermanentDeletion(intent);
          this.ports.lifecycle()?.resumeTeam(teamName);
        }
        throw error;
      }
    });
  }

  private getBackupService(): TeamBackupService {
    const service = this.ports.backupService();
    if (!service) {
      throw new Error(
        'Permanent deletion is unavailable until durable backup state is initialized'
      );
    }
    return service;
  }

  private withOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(teamName) ?? Promise.resolve();
    const next = previous.then(operation, () => operation());
    this.operations.set(teamName, next);
    next.then(
      () => {
        if (this.operations.get(teamName) === next) this.operations.delete(teamName);
      },
      () => {
        if (this.operations.get(teamName) === next) this.operations.delete(teamName);
      }
    );
    return next;
  }

  private async runCleanup(initialIntent: TeamPermanentDeletionIntent): Promise<void> {
    const backupService = this.getBackupService();
    const intent = await backupService.reconcilePermanentDeletionProgress(initialIntent);
    const teamDataAlreadyCompleted = intent.completedTargets.includes('team-data');
    if (
      !teamDataAlreadyCompleted &&
      !(await backupService.isPermanentDeletionTargetCurrent(intent))
    ) {
      this.ports.lifecycle()?.resumeTeam(intent.teamName);
      return;
    }

    if (!teamDataAlreadyCompleted) {
      await this.ports.lifecycle()?.prepareTeamDeletion(intent.teamName, intent.identityId);
      if (!(await backupService.isPermanentDeletionTargetCurrent(intent))) {
        this.ports.lifecycle()?.resumeTeam(intent.teamName);
        return;
      }
    }
    const cleanupCompleted = await backupService.withPermanentDeletionTargetFence(
      intent,
      async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
        if (
          (!isTargetCompleted('team-data') || !isTargetCompleted('task-data')) &&
          (await this.ports.dataService().permanentlyDeleteTeam(
            intent.teamName,
            (detachedPath) => isTargetCurrent('team-data', detachedPath),
            (detachedPath) => isTargetCurrent('task-data', detachedPath),
            {
              skipTeamData: isTargetCompleted('team-data'),
              skipTaskData: isTargetCompleted('task-data'),
              ...(!isTargetCompleted('team-data')
                ? { teamDataProofHooks: getTargetProofHooks('team-data') }
                : {}),
              ...(!isTargetCompleted('task-data')
                ? { taskDataProofHooks: getTargetProofHooks('task-data') }
                : {}),
            }
          )) === false
        ) {
          return false;
        }
        this.ports.invalidateTeamConfig(intent.teamName);
        if (
          !isTargetCompleted('message-attachments') &&
          !(await this.ports.attachmentStore.deleteTeamAttachments(
            intent.teamName,
            (detachedPath) => isTargetCurrent('message-attachments', detachedPath),
            getTargetProofHooks('message-attachments')
          ))
        ) {
          return false;
        }
        if (
          !isTargetCompleted('task-attachments') &&
          !(await this.ports.taskAttachmentStore.deleteTeamAttachments(
            intent.teamName,
            (detachedPath) => isTargetCurrent('task-attachments', detachedPath),
            getTargetProofHooks('task-attachments')
          ))
        ) {
          return false;
        }
        return (
          isTargetCompleted('team-data') &&
          isTargetCompleted('task-data') &&
          isTargetCompleted('message-attachments') &&
          isTargetCompleted('task-attachments')
        );
      }
    );
    if (!cleanupCompleted) {
      this.ports.lifecycle()?.resumeTeam(intent.teamName);
      return;
    }
    await backupService.completePermanentDeletion(intent);
    if (await backupService.isPermanentDeletionTargetCurrent(intent)) {
      this.ports.lifecycle()?.completeTeamDeletion(intent.teamName);
    } else {
      this.ports.lifecycle()?.resumeTeam(intent.teamName);
    }
  }

  private async recoverPending(): Promise<void> {
    const backupService = this.ports.backupService();
    if (!backupService) return;
    for (const intent of await backupService.listPendingPermanentDeletions()) {
      try {
        await this.permanentlyDelete(intent.teamName, { existingIntent: intent });
      } catch (error) {
        this.ports.logRecoveryError(intent.teamName, error);
      }
    }
  }
}
