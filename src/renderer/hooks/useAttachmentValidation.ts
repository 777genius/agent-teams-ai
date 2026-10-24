import { useCallback } from 'react';

import {
  validateAttachmentFilesForMember,
  validateAttachmentPayloadsForMember,
} from '@renderer/utils/attachmentRecipientCapabilities';

import type { MemberAttachmentDeclarationLookup } from '@renderer/utils/attachmentRecipientCapabilities';
import type { AttachmentPayload, ResolvedTeamMember } from '@shared/types';

export function useAttachmentValidation(
  member: ResolvedTeamMember | undefined,
  resolveDeclaration: MemberAttachmentDeclarationLookup,
  reportError: (reason: string) => void
) {
  const report = useCallback(
    (reason: string | null) => {
      if (!reason) return true;
      reportError(reason);
      return false;
    },
    [reportError]
  );
  return {
    validateFiles: useCallback(
      (files: FileList | File[]) =>
        report(validateAttachmentFilesForMember({ member, files, resolveDeclaration })),
      [member, resolveDeclaration, report]
    ),
    validatePayloads: useCallback(
      (attachments: readonly AttachmentPayload[]) =>
        report(validateAttachmentPayloadsForMember({ member, attachments, resolveDeclaration })),
      [member, resolveDeclaration, report]
    ),
  };
}
