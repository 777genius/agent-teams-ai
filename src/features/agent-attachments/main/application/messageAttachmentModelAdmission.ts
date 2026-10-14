import { isAgentVideoMimeType, resolveAgentAttachmentCapability } from '../../core/domain';

import type { AttachmentPayload, TeamProviderId, TeamViewSnapshot } from '@shared/types';

export async function getNativeAttachmentRecipientRestriction(input: {
  teamName: string;
  memberName: string;
  providerId: TeamProviderId | undefined;
  attachments: AttachmentPayload[];
  readTeamData: (teamName: string) => Promise<TeamViewSnapshot>;
}): Promise<string | null> {
  if (input.attachments.length === 0) {
    return null;
  }

  const snapshot =
    input.providerId === 'opencode' ? await input.readTeamData(input.teamName) : undefined;
  const normalizedMemberName = input.memberName.trim().toLowerCase();
  const member =
    snapshot?.members.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    ) ??
    snapshot?.config.members?.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    );
  const capability = resolveAgentAttachmentCapability({
    providerId: input.providerId ?? member?.providerId ?? 'unknown',
    model: member?.model,
    nativeInboxTextAttachmentsSupported: true,
  });

  let images = 0;
  let files = 0;
  let videos = 0;
  let total = 0;
  for (const attachment of input.attachments) {
    total += attachment.size;
    if (isAgentVideoMimeType(attachment.mimeType)) {
      if (!capability.supportsVideo) return capability.videoDisplayText;
      if (!capability.supportedVideoMimeTypes.some((mime) => mime === attachment.mimeType))
        return 'This video type is not supported by the selected model.';
      if (++videos > capability.maxVideos)
        return `Maximum ${capability.maxVideos} video attachment allowed`;
      if (attachment.size > capability.maxBytesPerVideo)
        return `Attachment "${attachment.filename}" exceeds 8MB limit`;
    } else if (attachment.mimeType.startsWith('image/')) {
      if (!capability.supportedImageMimeTypes.some((mime) => mime === attachment.mimeType))
        return capability.displayText;
      if (++images > capability.maxImages || attachment.size > capability.maxBytesPerImage)
        return 'Native image attachment exceeds the selected model size/count limit';
    } else {
      if (!capability.supportsFiles) return capability.filesDisplayText;
      if (++files > capability.maxFiles || attachment.size > capability.maxBytesPerFile)
        return 'Native file attachment exceeds the selected model size/count limit';
    }
  }
  return total > capability.maxBytesTotal
    ? 'Native attachments exceed the 8MB total size limit'
    : null;
}
