import { useOpenCodeAttachmentDeclarations } from '@features/runtime-provider-management/renderer';
import { useStore } from '@renderer/store';
import { attachmentTargetForMember } from '@renderer/utils/attachmentRecipientCapabilities';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type { MemberAttachmentDeclarationLookup } from '@renderer/utils/attachmentRecipientCapabilities';
import type { ResolvedTeamMember } from '@shared/types';

export function useRecipientAttachmentDeclarations(
  member: ResolvedTeamMember | undefined,
  projectPath: string | null,
  enabled = true
) {
  const contextKey = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.connectedHost,
      state.appConfig?.general.claudeRootPath,
      member?.name,
      member?.agentId,
      member?.joinedAt,
    ])
  );
  const isOpenCode =
    member &&
    (normalizeOptionalTeamProviderId(member.providerId) ??
      inferTeamProviderIdFromModel(member.model)) === 'opencode';
  const declarations = useOpenCodeAttachmentDeclarations(
    enabled && isOpenCode ? [attachmentTargetForMember(member, projectPath)] : [],
    contextKey
  );
  const resolveDeclaration: MemberAttachmentDeclarationLookup = (recipient) =>
    declarations.read(attachmentTargetForMember(recipient, projectPath));
  return { resolveDeclaration, refresh: declarations.refresh, isOpenCode };
}
