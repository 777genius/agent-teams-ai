import { DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET } from './budgets';
import { isAgentImageMimeType, isAgentVideoMimeType } from './mimeTypes';

import type {
  AgentAttachmentCapability,
  AgentAttachmentKind,
  AgentAttachmentPayload,
  AgentImageMimeType,
  AgentVideoMimeType,
  AttachmentValidationResult,
  AttachmentWarning,
  ImageOptimizationBudget,
} from './types';

const OPTIMIZABLE_AGENT_IMAGE_MIME_TYPES = new Set<Exclude<AgentImageMimeType, 'image/gif'>>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function isProviderImageMimeType(mimeType: string): mimeType is AgentImageMimeType {
  return isAgentImageMimeType(mimeType);
}

function isOptimizableAgentImageMimeType(
  mimeType: string
): mimeType is Exclude<AgentImageMimeType, 'image/gif'> {
  return OPTIMIZABLE_AGENT_IMAGE_MIME_TYPES.has(
    mimeType as Exclude<AgentImageMimeType, 'image/gif'>
  );
}

function isProviderFileMimeType(mimeType: string, supported: readonly string[]): boolean {
  return supported.some((candidate) =>
    candidate.endsWith('/*') ? mimeType.startsWith(candidate.slice(0, -1)) : candidate === mimeType
  );
}

function isCapabilityImageMimeType(
  mimeType: string,
  supported: readonly AgentImageMimeType[]
): boolean {
  return supported.includes(mimeType as AgentImageMimeType);
}

function isCapabilityVideoMimeType(
  mimeType: string,
  supported: readonly AgentVideoMimeType[]
): boolean {
  return supported.includes(mimeType as AgentVideoMimeType);
}

export interface AttachmentCapabilityValidationCandidate {
  kind: AgentAttachmentKind;
  mimeType: string;
  sizeBytes: number;
  warnings?: readonly AttachmentWarning[];
}

export function classifyAttachmentMime(mimeType: string): AgentAttachmentKind {
  if (isAgentImageMimeType(mimeType)) return 'image';
  if (isAgentVideoMimeType(mimeType)) return 'video';
  if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType.startsWith('text/')) {
    return 'file';
  }
  return 'unsupported';
}

export function validateImageOptimizationInput(input: {
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  budget?: ImageOptimizationBudget;
}): AttachmentValidationResult {
  const budget = input.budget ?? DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET;
  if (!isOptimizableAgentImageMimeType(input.mimeType)) {
    return {
      ok: false,
      code: 'attachment_type_unsupported',
      message: 'This image type is not supported for optimization.',
      warnings: [],
    };
  }
  if (input.sizeBytes <= 0) {
    return {
      ok: false,
      code: 'attachment_type_unsupported',
      message: 'Image file is empty.',
      warnings: [],
    };
  }
  if (input.sizeBytes > budget.maxInputBytes) {
    return {
      ok: false,
      code: 'attachment_too_large',
      message: 'Image is too large to prepare for sending.',
      warnings: [],
    };
  }
  if (input.width * input.height > budget.maxInputPixels) {
    return {
      ok: false,
      code: 'attachment_too_large',
      message: 'Image dimensions are too large to prepare for sending.',
      warnings: [],
    };
  }
  return { ok: true, warnings: [] };
}

function validateAttachmentCandidateForCapability(input: {
  attachment: AttachmentCapabilityValidationCandidate;
  capability: AgentAttachmentCapability;
}): AttachmentValidationResult {
  const { attachment, capability } = input;
  const warnings = [...(attachment.warnings ?? [])];

  if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes <= 0) {
    return {
      ok: false,
      code: 'attachment_provider_rejected',
      message: 'Attachment payload is empty or has an invalid byte size.',
      warnings,
    };
  }

  if (attachment.kind === 'video') {
    if (!capability.supportsVideo) {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: capability.videoDisplayText,
        warnings,
      };
    }

    if (!isCapabilityVideoMimeType(attachment.mimeType, capability.supportedVideoMimeTypes)) {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: 'This video type is not supported by the selected provider.',
        warnings,
      };
    }

    if (attachment.sizeBytes > capability.maxBytesPerVideo) {
      return {
        ok: false,
        code: 'attachment_too_large',
        message: 'Video is too large for the selected provider path.',
        warnings,
      };
    }

    return { ok: true, warnings };
  }

  if (attachment.kind !== 'image') {
    if (attachment.kind !== 'file') {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: 'This attachment type is not supported by the selected provider.',
        warnings,
      };
    }

    if (!capability.supportsFiles) {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: capability.filesDisplayText,
        warnings,
      };
    }

    if (!isProviderFileMimeType(attachment.mimeType, capability.supportedFileMimeTypes)) {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: 'This file type is not supported by the selected provider.',
        warnings,
      };
    }

    if (attachment.sizeBytes > capability.maxBytesPerFile) {
      return {
        ok: false,
        code: 'attachment_too_large',
        message: 'File is too large for the selected provider path.',
        warnings,
      };
    }

    return { ok: true, warnings };
  }

  if (!capability.supportsImages) {
    return {
      ok: false,
      code: 'attachment_model_unsupported',
      message: capability.displayText,
      warnings,
    };
  }

  if (!isCapabilityImageMimeType(attachment.mimeType, capability.supportedImageMimeTypes)) {
    return {
      ok: false,
      code: 'attachment_type_unsupported',
      message: 'This image type is not supported by the selected provider.',
      warnings,
    };
  }

  if (attachment.sizeBytes > capability.maxBytesPerImage) {
    return {
      ok: false,
      code: 'attachment_too_large',
      message: 'Image is too large after optimization. Remove it or use a smaller image.',
      warnings,
    };
  }

  return { ok: true, warnings };
}

export function validateAttachmentForCapability(input: {
  attachment: AgentAttachmentPayload;
  capability: AgentAttachmentCapability;
}): AttachmentValidationResult {
  return validateAttachmentCandidateForCapability(input);
}

export function validateAttachmentBatchForCapability(input: {
  attachments: readonly AttachmentCapabilityValidationCandidate[];
  capability: AgentAttachmentCapability;
}): AttachmentValidationResult {
  const warnings = input.attachments.flatMap((attachment) => [...(attachment.warnings ?? [])]);
  for (const attachment of input.attachments) {
    const result = validateAttachmentCandidateForCapability({
      attachment,
      capability: input.capability,
    });
    if (!result.ok) return { ...result, warnings };
  }

  const counts = input.attachments.reduce(
    (result, attachment) => {
      if (attachment.kind === 'image') result.images += 1;
      if (attachment.kind === 'file') result.files += 1;
      if (attachment.kind === 'video') result.videos += 1;
      return result;
    },
    { images: 0, files: 0, videos: 0 }
  );
  const countLimits = [
    ['image', counts.images, input.capability.maxImages],
    ['file', counts.files, input.capability.maxFiles],
    ['video', counts.videos, input.capability.maxVideos],
  ] as const;
  for (const [kind, count, limit] of countLimits) {
    if (count > limit) {
      return {
        ok: false,
        code: 'attachment_type_unsupported',
        message: `Maximum ${limit} ${kind} attachment${limit === 1 ? '' : 's'} for this provider path.`,
        warnings,
      };
    }
  }

  const totalBytes = input.attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0
  );
  if (totalBytes > input.capability.maxBytesTotal) {
    return {
      ok: false,
      code: 'attachment_too_large',
      message: 'Attachments exceed the total byte limit for the selected provider path.',
      warnings,
    };
  }

  return { ok: true, warnings };
}
