import type { AttachmentFileData } from '../models/TeamMessageDeliveryModels';
import type { MessageAttachmentStorePort } from '../ports/TeamMessageDeliveryPorts';

export class GetMessageAttachmentsUseCase {
  constructor(private readonly attachments: Pick<MessageAttachmentStorePort, 'getAttachments'>) {}

  execute(teamName: string, messageId: string): Promise<AttachmentFileData[]> {
    return this.attachments.getAttachments(teamName, messageId);
  }
}
