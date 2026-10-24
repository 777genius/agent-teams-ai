import {
  validateAgentAttachmentIpcPayload,
  type NormalizedAttachmentPayload,
} from '@agent-teams/legacy-agent-host/attachments/portable';
import type {
  AttachmentReference,
  AttachmentUpload,
} from '@agent-teams/legacy-agent-host/attachments/contracts';
import { BACKEND_ATTACHMENT_CHUNK_BYTES } from '../contracts/attachments';
import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { AttachmentPayload, CommentAttachmentPayload } from '@shared/types/team';

/** Normalize existing comment/chat DTOs before any owner lookup or upload effect. */
export function prepareHostAttachments(
  source: readonly (AttachmentPayload | CommentAttachmentPayload)[] | undefined,
  purpose: AttachmentUpload['purpose']['kind']
): NormalizedAttachmentPayload[] {
  if (source === undefined) return [];
  if (!Array.isArray(source)) throw new Error('Invalid attachments');
  const normalized = validateAgentAttachmentIpcPayload(
    source.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('Invalid attachment');
      const data = 'base64Data' in item ? item.base64Data : item.data;
      if (typeof data !== 'string') throw new Error('Invalid attachment data');
      const bytes = atob(data);
      return {
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        size: bytes.length,
        data,
      };
    }),
    purpose
  );
  if (!normalized.valid) throw new Error(normalized.error);
  return normalized.value;
}

/** One captured handle for upload and publication. Unknown uploads are retained, never resent to another owner. */
export async function uploadHostAttachments(options: {
  backend: AgentBackendApi;
  handle: BackendHandle;
  current(): boolean;
  commandId: string;
  purpose: AttachmentUpload['purpose'];
  source: readonly NormalizedAttachmentPayload[];
}): Promise<AttachmentReference[]> {
  const refs: AttachmentReference[] = [];
  for (const item of options.source) {
    const bytes = Uint8Array.from(atob(item.data), (char) => char.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    for (let offset = 0; offset < bytes.length; offset += BACKEND_ATTACHMENT_CHUNK_BYTES) {
      if (!options.current()) throw new Error('Team context changed');
      const chunk = bytes.subarray(offset, offset + BACKEND_ATTACHMENT_CHUNK_BYTES);
      const segments: string[] = [];
      for (let position = 0; position < chunk.length; position += 8192)
        segments.push(String.fromCharCode(...chunk.subarray(position, position + 8192)));
      const result = await options.backend.invoke({
        handle: options.handle,
        commandId: options.commandId,
        operation: 'attachment.upload',
        payload: {
          uploadId: options.commandId,
          purpose: options.purpose,
          attachment: {
            id: item.id,
            filename: item.filename,
            mimeType: item.mimeType,
            size: bytes.length,
          },
          digest,
          offset,
          base64: btoa(segments.join('')),
        },
      });
      if (!options.current()) throw new Error('Team context changed');
      if (!result.ok || !result.value || !('nextOffset' in result.value))
        throw new Error('Attachment upload failed');
      const end = offset + chunk.length;
      if (end < bytes.length) {
        if (result.value.nextOffset !== end) throw new Error('Invalid upload offset');
      } else {
        const reference = 'reference' in result.value ? result.value.reference : undefined;
        if (
          result.value.nextOffset !== null ||
          !reference ||
          reference.digest !== digest ||
          reference.byteLength !== bytes.length ||
          reference.mimeType !== item.mimeType ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(reference.artifactId)
        )
          throw new Error('Invalid upload reference');
        refs.push(reference);
      }
    }
  }
  return refs;
}
