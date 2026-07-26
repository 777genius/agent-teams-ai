import { TeamBackupService } from './TeamBackupService';
import { TeamTaskAttachmentStore } from './TeamTaskAttachmentStore';

export { TeamBackupService };

export function createTeamBackupService(taskReader: {
  getTask(
    teamName: string,
    taskId: string
  ): Promise<{ attachments?: ReadonlyArray<{ id: string }> } | null>;
}): TeamBackupService {
  const recoveryStore = new TeamTaskAttachmentStore();
  const isReferenced = async (
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<boolean> => {
    const task = await taskReader.getTask(teamName, taskId);
    return task?.attachments?.some((attachment) => attachment.id === attachmentId) ?? false;
  };
  return new TeamBackupService({
    reconcilePendingDeletions: () =>
      recoveryStore.reconcilePendingAttachmentDeletions(isReferenced),
    getBackupExclusions: (teamName) =>
      recoveryStore.getTaskAttachmentBackupExclusions(teamName, isReferenced),
    getBackupExclusionsSync: (teamName) =>
      recoveryStore.getTaskAttachmentBackupExclusionsSync(teamName),
    getPendingTeams: () => recoveryStore.getPendingTaskAttachmentDeletionTeams(),
    getPendingPaths: (teamName) => recoveryStore.getPendingTaskAttachmentDeletionPaths(teamName),
    completePendingDeletions: (teamName, backedUpReplacements) =>
      recoveryStore.completePendingTaskAttachmentDeletions(
        teamName,
        isReferenced,
        backedUpReplacements
      ),
  });
}
