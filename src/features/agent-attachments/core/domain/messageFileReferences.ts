import { decorateFileReferences as decorateVerifiedFileReferences } from '@agent-teams/legacy-agent-host/attachments/portable';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import type { AttachmentMeta } from '../../contracts/nativeTeammateAttachment';

export type { MessageAttachmentTarget } from '@agent-teams/legacy-agent-host/attachments/portable';
export {
  getMessageAttachmentRoute,
  isStrictUtf8,
} from '@agent-teams/legacy-agent-host/attachments/portable';

/** UI/provenance projection only. Raw inbox subsets remain separate. */
export function mergeMessageAttachments(message: {
  attachments?: readonly AttachmentMeta[];
  fileReferences?: readonly AttachmentMeta[];
}): AttachmentMeta[] {
  const ids = new Set<string>();
  const merged = [...(message.attachments ?? []), ...(message.fileReferences ?? [])].filter(
    (item) => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    }
  );
  const ordered = merged.every((item) => Number.isSafeInteger(item.order) && item.order! >= 0);
  return ordered ? merged.sort((a, b) => a.order! - b.order!) : merged;
}

export function decorateFileReferences(
  text: string,
  references: readonly AttachmentMeta[]
): string {
  return decorateVerifiedFileReferences(text, references, wrapAgentBlock);
}
