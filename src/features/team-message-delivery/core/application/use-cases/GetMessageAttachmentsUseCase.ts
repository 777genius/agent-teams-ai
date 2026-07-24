import type { MessageAttachmentStorePort } from '../ports/TeamMessageDeliveryPorts';
import type { AttachmentFileData } from '@shared/types';

export class GetMessageAttachmentsUseCase {
  constructor(private readonly attachments: Pick<MessageAttachmentStorePort, 'getAttachments'>) {}

  execute(teamName: string, messageId: string): Promise<AttachmentFileData[]> {
    return this.attachments.getAttachments(teamName, messageId);
  }
}
