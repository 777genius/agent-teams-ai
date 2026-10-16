import {
  type AgentAttachmentCapability,
  getMessageAttachmentRoute,
  isStrictUtf8,
  resolveAgentAttachmentCapability,
} from '@features/agent-attachments/renderer';
import { getEffectiveMimeType, isImageMime, isVideoMime } from '@shared/constants/attachments';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type { AttachmentPayload, ResolvedTeamMember } from '@shared/types';

export function attachmentTargetForMember(member: ResolvedTeamMember, projectPath: string | null) {
  return {
    model: member.model,
    projectPath:
      member.laneKind === 'secondary' && member.laneOwnerProviderId === 'opencode'
        ? member.cwd?.trim() || projectPath
        : projectPath || member.cwd?.trim() || null,
  };
}

export interface MemberAttachmentDeclaration {
  declaredInputModalities: readonly string[] | null;
  unavailableReason?: string;
}
export type MemberAttachmentDeclarationLookup = (
  member: ResolvedTeamMember
) => MemberAttachmentDeclaration;

export interface MemberAttachmentCapabilityResult {
  capability: AgentAttachmentCapability;
  providerId: string;
  model: string;
}

function getMemberProviderId(member: ResolvedTeamMember): string {
  return (
    normalizeOptionalTeamProviderId(member.providerId) ??
    inferTeamProviderIdFromModel(member.model) ??
    'unknown'
  );
}

function isSupportedFileMime(mimeType: string, supported: readonly string[]): boolean {
  return supported.some((candidate) =>
    candidate.endsWith('/*') ? mimeType.startsWith(candidate.slice(0, -1)) : candidate === mimeType
  );
}

function isSupportedImageMime(mimeType: string, supported: readonly string[]): boolean {
  return supported.includes(mimeType);
}

function isSupportedVideoMime(mimeType: string, supported: readonly string[]): boolean {
  return supported.includes(mimeType);
}

export function resolveMemberAttachmentCapability(
  member: ResolvedTeamMember,
  declaration?: MemberAttachmentDeclaration
): MemberAttachmentCapabilityResult {
  const providerId = getMemberProviderId(member);
  const model = member.model ?? '';
  return {
    providerId,
    model,
    capability: resolveAgentAttachmentCapability({
      providerId,
      model,
      declaredInputModalities: declaration?.declaredInputModalities,
      nativeInboxTextAttachmentsSupported:
        !isLeadMember(member) &&
        member.nativeInboxAttachmentsSupported === true &&
        member.nativeInboxTextAttachmentsSupported === true,
    }),
  };
}

export function getMemberAttachmentUnavailableReason(
  member: ResolvedTeamMember | null | undefined
): string | null {
  if (!member) {
    return 'Select a recipient before attaching files.';
  }
  return ['anthropic', 'codex', 'opencode'].includes(getMemberProviderId(member))
    ? null
    : 'Attachments require a supported recipient provider.';
}

export function getAttachmentInputAcceptForMember(
  _member: ResolvedTeamMember | null | undefined
): string {
  return '*/*';
}

export function validateAttachmentFilesForMember(input: {
  member: ResolvedTeamMember | null | undefined;
  files: FileList | File[];
  resolveDeclaration?: MemberAttachmentDeclarationLookup;
}): string | null {
  const unavailable = getMemberAttachmentUnavailableReason(input.member);
  if (unavailable) return unavailable;
  // Text eligibility requires original bytes; defer it to the payload boundary.
  return validateAttachmentPayloadsForMember({
    member: input.member,
    resolveDeclaration: input.resolveDeclaration,
    attachments: Array.from(input.files)
      .filter((file) => getEffectiveMimeType(file) !== 'text/plain')
      .map((file) => ({
        id: '',
        filename: file.name,
        mimeType: getEffectiveMimeType(file),
        size: file.size,
        data: '',
      })),
  });
}

export function validateAttachmentPayloadsForMember(input: {
  member: ResolvedTeamMember | null | undefined;
  attachments: readonly AttachmentPayload[];
  resolveDeclaration?: MemberAttachmentDeclarationLookup;
}): string | null {
  const member = input.member;
  if (!member || input.attachments.length === 0) {
    return null;
  }
  const unavailable = getMemberAttachmentUnavailableReason(member);
  if (unavailable) return unavailable;
  const declaration = input.resolveDeclaration?.(member);
  const { capability } = resolveMemberAttachmentCapability(member, declaration);

  let imageCount = 0;
  let fileCount = 0;
  let videoCount = 0;
  let totalBytes = 0;
  for (const attachment of input.attachments) {
    let validUtf8 = true;
    if (attachment.mimeType === 'text/plain') {
      try {
        validUtf8 = isStrictUtf8(
          Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0))
        );
      } catch {
        return 'Attachment data is invalid.';
      }
    }
    if (
      getMessageAttachmentRoute(
        { providerId: getMemberProviderId(member), isLeadRecipient: isLeadMember(member) },
        attachment.mimeType,
        validUtf8
      ) === 'reference'
    )
      continue;
    if (
      !isLeadMember(member) &&
      ['anthropic', 'codex'].includes(getMemberProviderId(member)) &&
      member.nativeInboxAttachmentsSupported !== true
    ) {
      return 'Native teammate attachments require a current attachment-capable runtime.';
    }
    totalBytes += attachment.size;
    if (isImageMime(attachment.mimeType)) {
      imageCount += 1;
      if (!capability.supportsImages) {
        return declaration?.unavailableReason ?? capability.displayText;
      }
      if (!isSupportedImageMime(attachment.mimeType, capability.supportedImageMimeTypes)) {
        return 'This image type is not supported by the selected model.';
      }
      if (attachment.size > capability.maxBytesPerImage) {
        return 'Image is too large for the selected model.';
      }
      continue;
    }
    if (isVideoMime(attachment.mimeType)) {
      videoCount += 1;
      if (!capability.supportsVideo) {
        return declaration?.unavailableReason ?? capability.videoDisplayText;
      }
      if (!isSupportedVideoMime(attachment.mimeType, capability.supportedVideoMimeTypes)) {
        return 'This video type is not supported by the selected model.';
      }
      if (attachment.size > capability.maxBytesPerVideo) {
        return 'Video is too large for the selected model.';
      }
      continue;
    }

    fileCount += 1;
    if (!capability.supportsFiles) {
      return capability.filesDisplayText;
    }
    if (!isSupportedFileMime(attachment.mimeType, capability.supportedFileMimeTypes)) {
      return 'This file type is not supported by the selected model.';
    }
    if (attachment.size > capability.maxBytesPerFile) {
      return 'File is too large for the selected model.';
    }
  }

  if (imageCount > capability.maxImages) {
    return `Maximum ${capability.maxImages} image attachments for this model.`;
  }
  if (fileCount > capability.maxFiles) {
    return `Maximum ${capability.maxFiles} file attachments for this model.`;
  }
  if (videoCount > capability.maxVideos) {
    return `Maximum ${capability.maxVideos} video attachment${
      capability.maxVideos === 1 ? '' : 's'
    } for this model.`;
  }
  if (totalBytes > capability.maxBytesTotal) {
    return 'Attachments exceed the selected model size limit.';
  }

  return null;
}

export function canMemberShowAttachmentControl(
  member: ResolvedTeamMember | null | undefined
): boolean {
  if (!member) {
    return false;
  }
  return ['anthropic', 'codex', 'opencode'].includes(getMemberProviderId(member));
}

export function isReferenceAttachmentForMember(
  member: ResolvedTeamMember | null | undefined,
  attachment: AttachmentPayload
): boolean {
  if (!member || getMemberAttachmentUnavailableReason(member)) return false;
  let validUtf8 = true;
  if (attachment.mimeType === 'text/plain') {
    try {
      validUtf8 = isStrictUtf8(
        Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0))
      );
    } catch {
      return false;
    }
  }
  return (
    getMessageAttachmentRoute(
      { providerId: getMemberProviderId(member), isLeadRecipient: isLeadMember(member) },
      attachment.mimeType,
      validUtf8
    ) === 'reference'
  );
}
