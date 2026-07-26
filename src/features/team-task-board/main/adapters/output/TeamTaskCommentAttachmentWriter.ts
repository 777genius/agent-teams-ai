import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';

import type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentTransactionPort,
  TaskCommentAttachmentWriterPort,
} from '../../../core/application/ports/TeamTaskBoardPorts';

export class TeamTaskCommentAttachmentWriter implements TaskCommentAttachmentWriterPort {
  constructor(private readonly store: TeamTaskAttachmentStore = new TeamTaskAttachmentStore()) {}

  async runTransaction<T>(
    teamName: string,
    taskId: string,
    operation: (transaction: TaskCommentAttachmentTransactionPort) => Promise<T>
  ): Promise<T> {
    return this.store.runTaskTransaction(teamName, taskId, (storeTransaction) =>
      operation({
        saveAttachment: async (attachmentId, filename, mimeType, base64Data) => {
          const receipt = await storeTransaction.saveAttachmentWithReceipt(
            attachmentId,
            filename,
            mimeType,
            base64Data
          );
          return {
            metadata: receipt.metadata,
            finalize: () => storeTransaction.finalizeAttachment(receipt),
            rollback: () => storeTransaction.rollbackAttachment(receipt),
          } satisfies SavedTaskCommentAttachment;
        },
      })
    );
  }
}
