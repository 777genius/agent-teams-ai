import {
  decorateFileReferences,
  getMessageAttachmentRoute,
  isStrictUtf8,
} from '../../core/domain/messageFileReferences';

import type { MessageAttachmentTarget } from '../../core/domain/messageFileReferences';
import type {
  NativeAttachmentStore,
  NativeStoredAttachmentMeta,
} from './nativeTeammateAttachmentAdmission';
import type { AttachmentPayload } from '@shared/types';

export function selectNativeMessageAttachments(
  target: MessageAttachmentTarget,
  attachments: readonly AttachmentPayload[]
): AttachmentPayload[] {
  return attachments.filter(
    (attachment) =>
      getMessageAttachmentRoute(
        target,
        attachment.mimeType,
        attachment.mimeType !== 'text/plain' || isStrictUtf8(Buffer.from(attachment.data, 'base64'))
      ) === 'native'
  );
}

export async function prepareMessageAttachments(
  input: MessageAttachmentTarget & {
    teamName: string;
    messageId: string;
    text: string;
    from?: string;
    attachments: AttachmentPayload[];
  },
  store: NativeAttachmentStore
): Promise<{
  text: string;
  stored: NativeStoredAttachmentMeta[];
  attachments: NativeStoredAttachmentMeta[];
  nativePayloads: AttachmentPayload[];
  fileReferences: NativeStoredAttachmentMeta[];
}> {
  if (input.from !== undefined && input.from.trim().toLowerCase() !== 'user') {
    throw new Error('Message file attachments require user origin');
  }
  const nativePayloads = selectNativeMessageAttachments(input, input.attachments);
  const nativeIds = new Set(nativePayloads.map((attachment) => attachment.id));
  const bundle = await store.saveNativeAttachments(
    input.teamName,
    input.messageId,
    input.attachments
  );
  if (bundle.length !== input.attachments.length)
    throw new Error('Attachment storage did not complete the full batch');
  const stored = bundle.map((attachment, order) => ({ ...attachment, order }));
  const attachments = stored.filter((attachment) => nativeIds.has(attachment.id));
  const fileReferences = stored.filter((attachment) => !nativeIds.has(attachment.id));
  return {
    text: decorateFileReferences(input.text, fileReferences),
    stored,
    attachments,
    nativePayloads,
    fileReferences,
  };
}
