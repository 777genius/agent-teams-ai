import { readBackendMessageAttachments } from '../contracts/attachments';

import { readHostAttachment } from './createHostTaskAttachmentRead';

import type { HostAttachmentReadOptions } from './createHostTaskAttachmentRead';
import type { TeamsAPI } from '@shared/types/api';

/** Read selected-Team owned messages and archive-qualified source messages without ambient legacy paths. */
export function createHostMessageAttachmentRead(
  options: HostAttachmentReadOptions
): TeamsAPI['getAttachments'] {
  return async (selection, reference) => {
    if (
      !/^(?:im1:[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.test(
        reference
      )
    )
      throw new Error('Invalid source message reference');
    const current = options.captureScope();
    if (!current()) throw new Error('Team context changed');
    const target = await options.resolve(selection, current);
    target.assertCurrent();
    const result = await options.backend.invoke({
      handle: target.handle,
      commandId: crypto.randomUUID(),
      operation: 'message.attachments.read',
      payload: { reference },
    });
    if (!current()) throw new Error('Team context changed');
    target.assertCurrent();
    if (!result.ok) throw new Error(`Host attachment read ${result.code}`);
    const metadata = readBackendMessageAttachments(result.value);
    const files: Awaited<ReturnType<TeamsAPI['getAttachments']>> = [];
    for (const item of metadata) {
      const data = await readHostAttachment(
        options.backend,
        target,
        current,
        { reference },
        item.id,
        item.mimeType,
        item
      );
      if (data !== null) files.push({ id: item.id, mimeType: item.mimeType, data });
    }
    if (!current()) throw new Error('Team context changed');
    target.assertCurrent();
    return files;
  };
}
