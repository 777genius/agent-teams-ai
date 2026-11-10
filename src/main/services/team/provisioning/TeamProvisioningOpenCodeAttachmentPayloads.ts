import { getErrorMessage } from '@shared/utils/errorHandling';

import type { AttachmentMeta, AttachmentPayload, InboxMessage } from '@shared/types';

export interface OpenCodeAttachmentPayloadStore {
  getAttachments(
    teamName: string,
    messageId: string
  ): Promise<readonly { id: string; data: string; mimeType: string }[]>;
}

export type OpenCodeInboxAttachmentPayloadsResult =
  | { ok: true; attachments?: AttachmentPayload[] }
  | { ok: false; reason: string; diagnostics: string[] };

export function asOpenCodeAttachmentPayload(meta: AttachmentMeta): AttachmentPayload | null {
  const data = (meta as Partial<AttachmentPayload>).data;
  return typeof data === 'string'
    ? {
        ...meta,
        data,
      }
    : null;
}

export async function resolveOpenCodeInboxAttachmentPayloads(
  input: {
    teamName: string;
    message: InboxMessage & { messageId: string };
  },
  ports: { attachmentStore: OpenCodeAttachmentPayloadStore }
): Promise<OpenCodeInboxAttachmentPayloadsResult> {
  const metas = input.message.attachments ?? [];
  if (metas.length === 0) {
    return { ok: true };
  }

  let fileDataById: Map<string, { data: string; mimeType: string }> | null = null;
  const payloads: AttachmentPayload[] = [];
  const missingIds: string[] = [];
  for (const meta of metas) {
    const inlinePayload = asOpenCodeAttachmentPayload(meta);
    if (inlinePayload) {
      payloads.push(inlinePayload);
      continue;
    }

    if (!fileDataById) {
      let fileData: Awaited<ReturnType<OpenCodeAttachmentPayloadStore['getAttachments']>>;
      try {
        fileData = await ports.attachmentStore.getAttachments(
          input.teamName,
          input.message.messageId
        );
      } catch (error) {
        const reason = `opencode_inbox_attachment_payload_read_failed: ${getErrorMessage(error)}`;
        return { ok: false, reason, diagnostics: [reason] };
      }
      fileDataById = new Map(
        fileData.map((attachment) => [
          attachment.id,
          { data: attachment.data, mimeType: attachment.mimeType },
        ])
      );
    }
    const data = fileDataById.get(meta.id);
    if (!data) {
      missingIds.push(meta.id);
      continue;
    }
    payloads.push({
      ...meta,
      mimeType: meta.mimeType || data.mimeType,
      data: data.data,
    });
  }

  if (missingIds.length > 0) {
    const reason = `opencode_inbox_attachment_payload_unavailable: ${missingIds.join(', ')}`;
    return { ok: false, reason, diagnostics: [reason] };
  }

  return { ok: true, attachments: payloads };
}
