import {
  type AgentAttachmentCapability,
  resolveAgentAttachmentCapability,
} from '@features/agent-attachments/renderer';
import {
  categorizeFile,
  getEffectiveMimeType,
  isImageMime,
  isVideoMime,
  TEXT_FILE_EXTENSIONS,
} from '@shared/constants/attachments';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type { AttachmentPayload, ResolvedTeamMember } from '@shared/types';

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

function canReceiveAnyAttachment(capability: AgentAttachmentCapability): boolean {
  return capability.supportsImages || capability.supportsFiles || capability.supportsVideo;
}

export function resolveMemberAttachmentCapability(
  member: ResolvedTeamMember
): MemberAttachmentCapabilityResult {
  const providerId = getMemberProviderId(member);
  const model = member.model ?? '';
  return {
    providerId,
    model,
    capability: resolveAgentAttachmentCapability({
      providerId,
      model,
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
  const { capability, providerId } = resolveMemberAttachmentCapability(member);
  if (
    !isLeadMember(member) &&
    (providerId === 'anthropic' || providerId === 'codex') &&
    member.nativeInboxAttachmentsSupported !== true
  ) {
    return 'Native teammate attachments are unavailable until this teammate is running a current attachment-capable runtime.';
  }
  if (canReceiveAnyAttachment(capability)) {
    return null;
  }
  return capability.displayText;
}

export function getAttachmentInputAcceptForMember(
  member: ResolvedTeamMember | null | undefined
): string {
  if (!member) {
    return '*/*';
  }
  const { capability } = resolveMemberAttachmentCapability(member);
  if (!capability.supportsFiles) {
    return [
      ...(capability.supportsImages ? capability.supportedImageMimeTypes : []),
      ...(capability.supportsVideo ? capability.supportedVideoMimeTypes : []),
    ].join(',');
  }
  if (
    capability.supportedFileMimeTypes.includes('text/*') ||
    capability.supportedFileMimeTypes.includes('application/pdf')
  )
    return '*/*';
  return [
    ...capability.supportedImageMimeTypes,
    ...capability.supportedFileMimeTypes,
    ...Array.from(TEXT_FILE_EXTENSIONS, (extension) => `.${extension}`),
  ].join(',');
}

export function validateAttachmentFilesForMember(input: {
  member: ResolvedTeamMember | null | undefined;
  files: FileList | File[];
}): string | null {
  const member = input.member;
  if (!member) {
    return 'Select a recipient before attaching files.';
  }
  const files = Array.from(input.files);
  if (files.length === 0) {
    return null;
  }
  const unavailable = getMemberAttachmentUnavailableReason(member);
  if (unavailable) return unavailable;
  const { capability } = resolveMemberAttachmentCapability(member);
  if (!canReceiveAnyAttachment(capability)) {
    return capability.displayText;
  }

  let videoCount = 0;
  for (const file of files) {
    const category = categorizeFile(file);
    if (category === 'unsupported') {
      continue;
    }
    if (category === 'image') {
      if (!capability.supportsImages) {
        return capability.displayText;
      }
      const mimeType = getEffectiveMimeType(file);
      if (!isSupportedImageMime(mimeType, capability.supportedImageMimeTypes)) {
        return 'This image type is not supported by the selected model.';
      }
      continue;
    }
    if (category === 'video') {
      videoCount += 1;
      if (!capability.supportsVideo) {
        return capability.videoDisplayText;
      }
      const mimeType = getEffectiveMimeType(file);
      if (!isSupportedVideoMime(mimeType, capability.supportedVideoMimeTypes)) {
        return 'This video type is not supported by the selected model.';
      }
      if (file.size > capability.maxBytesPerVideo) {
        return 'Video is too large for the selected model.';
      }
      continue;
    }
    if (!capability.supportsFiles) {
      return capability.filesDisplayText;
    }
    const mimeType = getEffectiveMimeType(file);
    if (!isSupportedFileMime(mimeType, capability.supportedFileMimeTypes)) {
      return 'This file type is not supported by the selected model.';
    }
  }

  if (videoCount > capability.maxVideos) {
    return `Maximum ${capability.maxVideos} video attachment${
      capability.maxVideos === 1 ? '' : 's'
    } for this model.`;
  }

  return null;
}

export function validateAttachmentPayloadsForMember(input: {
  member: ResolvedTeamMember | null | undefined;
  attachments: readonly AttachmentPayload[];
}): string | null {
  const member = input.member;
  if (!member || input.attachments.length === 0) {
    return null;
  }
  const unavailable = getMemberAttachmentUnavailableReason(member);
  if (unavailable) return unavailable;
  const { capability } = resolveMemberAttachmentCapability(member);
  if (!canReceiveAnyAttachment(capability)) {
    return capability.displayText;
  }

  let imageCount = 0;
  let fileCount = 0;
  let videoCount = 0;
  let totalBytes = 0;
  for (const attachment of input.attachments) {
    totalBytes += attachment.size;
    if (isImageMime(attachment.mimeType)) {
      imageCount += 1;
      if (!capability.supportsImages) {
        return capability.displayText;
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
        return capability.videoDisplayText;
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
  const providerId = getMemberProviderId(member);
  return (
    isLeadMember(member) ||
    providerId === 'opencode' ||
    ((providerId === 'anthropic' || providerId === 'codex') &&
      member.nativeInboxAttachmentsSupported === true)
  );
}
