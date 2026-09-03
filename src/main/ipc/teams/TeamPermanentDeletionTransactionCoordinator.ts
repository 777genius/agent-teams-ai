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

const PREPARE_TEAM_DELETION_TIMEOUT_MS = 30_000;

export interface TeamPermanentDeletionTransactionCoordinatorPorts {
  backupService(): TeamBackupService | null;
  dataService(): TeamPermanentDeletionDataPort;
  attachmentStore: TeamAttachmentStore;
  taskAttachmentStore: TeamTaskAttachmentStore;
  lifecycle(): TeamPermanentDeletionLifecycle | null;
  invalidateTeamConfig(teamName: string): void;
  logRecoveryError(teamName: string, error: unknown): void;
  /**
   * Close the process's own handles inside teams/<team> and tasks/<team>
   * (directory watchers and similar team-scoped resources) right before the
   * destructive detach rename. On Windows any open handle in the tree makes
   * that rename fail with EPERM, and a watcher handle never clears on its own,
   * so the transient rename retry cannot recover from one.
   */
  releaseTeamScopedResources?(teamName: string): Promise<void>;
  /**
   * Undo releaseTeamScopedResources once the cleanup attempt is over.
   * `deletionCompleted` says whether the team is actually gone: a released
   * resource that only makes sense for a team that still exists must be put
   * back when it is false and left alone when it is true.
   */
  restoreTeamScopedResources?(
    teamName: string,
    options: { deletionCompleted: boolean }
  ): Promise<void>;
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
      await this.prepareTeamDeletionWithTimeout(intent.teamName, intent.identityId);
      if (!(await backupService.isPermanentDeletionTargetCurrent(intent))) {
        this.ports.lifecycle()?.resumeTeam(intent.teamName);
        return;
      }
    }

    const resourcesReleased = await this.releaseTeamScopedResources(intent.teamName);
    let deletionCompleted = false;
    try {
      deletionCompleted = await this.runFencedCleanup(intent);
    } finally {
      if (resourcesReleased && this.ports.restoreTeamScopedResources) {
        await this.ports
          .restoreTeamScopedResources(intent.teamName, { deletionCompleted })
          .catch(() => undefined);
      }
    }
  }

  private async releaseTeamScopedResources(teamName: string): Promise<boolean> {
    if (!this.ports.releaseTeamScopedResources) {
      return false;
    }
    try {
      await this.ports.releaseTeamScopedResources(teamName);
      return true;
    } catch {
      // Best effort: a failed release leaves the rename exactly where it was
      // before, retrying against whatever still holds the handle.
      return false;
    }
  }

  /** Resolves true only when the team was really removed and marked complete. */
  private async runFencedCleanup(intent: TeamPermanentDeletionIntent): Promise<boolean> {
    const backupService = this.getBackupService();
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
      return false;
    }
    await backupService.completePermanentDeletion(intent);
    if (await backupService.isPermanentDeletionTargetCurrent(intent)) {
      this.ports.lifecycle()?.completeTeamDeletion(intent.teamName);
    } else {
      // Something else already owns the team name. The identity this intent
      // targeted is still gone, so the deletion did complete; only the
      // lifecycle call differs, because the replacement has to be running.
      // The deletion stays completed for the restore: what was released
      // belonged to the identity that is gone, and the replacement owns its
      // own resources.
      this.ports.lifecycle()?.resumeTeam(intent.teamName);
    }
    return true;
  }

  /**
   * The quiesce that precedes a permanent deletion drains in-flight team
   * operations and has no deadline of its own. One wedged operation - a runtime
   * bridge call that never settles, say - parks the whole deletion with neither
   * a result nor an error: the dialog closes, the team stays, and nothing is
   * written anywhere the user can see. Bounding the wait turns that into a
   * rejection with a message that says what to do about it.
   */
  private async prepareTeamDeletionWithTimeout(
    teamName: string,
    deletionIdentityId: string
  ): Promise<void> {
    const lifecycle = this.ports.lifecycle();
    if (!lifecycle) return;
    const preparation = lifecycle.prepareTeamDeletion(teamName, deletionIdentityId);
    // The quiesce keeps running after a timeout; claim its rejection here so a
    // late failure cannot surface as an unhandled rejection.
    void preparation.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Permanent deletion of "${teamName}" timed out after ${PREPARE_TEAM_DELETION_TIMEOUT_MS}ms waiting for team activity to quiesce. ` +
                  'The team was not deleted. Wait for running agents or runtime lanes to settle, then try again.'
              )
            );
          }, PREPARE_TEAM_DELETION_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
