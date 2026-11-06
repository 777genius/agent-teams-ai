import { readBackendAttachmentChunk } from '../contracts/attachments';

import type { BackendHandle } from '../contracts';
import type { BackendAttachmentMetadata } from '../contracts/attachments';
import type { AgentBackendApi } from '../contracts/operations';
import type { TeamsAPI } from '@shared/types/api';

export interface HostAttachmentReadOptions {
  backend: AgentBackendApi;
  captureScope: () => () => boolean;
  resolve(
    selection: string,
    current: () => boolean
  ): Promise<{ handle: BackendHandle; assertCurrent(): void }>;
}
export function createHostTaskAttachmentRead(
  options: HostAttachmentReadOptions
): TeamsAPI['getTaskAttachment'] {
  return async (selection, taskId, attachmentId, mimeType) => {
    const current = options.captureScope();
    if (!current()) throw new Error('Team context changed');
    const target = await options.resolve(selection, current);
    return readHostAttachment(options.backend, target, current, { taskId }, attachmentId, mimeType);
  };
}

/** Shared bounded transport and final byte-integrity check for both existing attachment controls. */
export async function readHostAttachment(
  backend: AgentBackendApi,
  target: { handle: BackendHandle; assertCurrent(): void },
  current: () => boolean,
  identity: { taskId: string } | { reference: string },
  attachmentId: string,
  mimeType: string,
  expectedMetadata?: BackendAttachmentMetadata
): Promise<string | null> {
  let offset = 0,
    expectedSha256: string | undefined,
    metadata: string | undefined;
  const chunks: string[] = [];
  // 20MiB at 384KiB per chunk; one final empty-file read is permitted.
  for (let count = 0; count < 55; count++) {
    target.assertCurrent();
    const payload = {
      ...identity,
      attachmentId,
      offset,
      ...(expectedSha256 ? { expectedSha256 } : {}),
    };
    const result = await backend.invoke({
      handle: target.handle,
      commandId: crypto.randomUUID(),
      ...('taskId' in identity
        ? {
            operation: 'task.attachment.read' as const,
            payload: { ...payload, taskId: identity.taskId },
          }
        : {
            operation: 'message.attachment.read' as const,
            payload: { ...payload, reference: identity.reference },
          }),
    });
    if (!current()) throw new Error('Team context changed');
    target.assertCurrent();
    if (!result.ok) throw new Error(`Host attachment read ${result.code}`);
    const chunk = readBackendAttachmentChunk(result.value, payload);
    if (chunk === null) {
      if (chunks.length) throw new Error('Attachment changed during read');
      return null;
    }
    if (chunk.attachment.mimeType !== mimeType) throw new Error('Attachment metadata changed');
    const observed = JSON.stringify(chunk.attachment);
    if (expectedMetadata && observed !== JSON.stringify(expectedMetadata))
      throw new Error('Attachment metadata changed');
    if (metadata !== undefined && metadata !== observed)
      throw new Error('Attachment metadata changed');
    metadata = observed;
    expectedSha256 = chunk.sha256;
    chunks.push(chunk.base64);
    if (chunk.nextOffset === null) {
      const data = chunks.join('');
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const observedHash = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      if (!current()) throw new Error('Team context changed');
      target.assertCurrent();
      if (observedHash !== expectedSha256) throw new Error('Attachment content integrity failed');
      return data;
    }
    offset = chunk.nextOffset;
  }
  throw new Error('Host attachment read exceeded limit');
}
