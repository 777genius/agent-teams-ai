import {
  DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET,
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
  MAX_AGENT_VIDEO_ATTACHMENT_BYTES,
} from './budgets';
import { resolveAgentAttachmentCapability } from './capabilities';
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
const ALLOWED_AGENT_ATTACHMENT_IPC_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
]);
const MAX_AGENT_ATTACHMENT_IPC_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_ATTACHMENT_IPC_BYTES_TOTAL = 20 * 1024 * 1024;
const MAX_AGENT_VIDEO_ATTACHMENTS = 1;
const MAX_AGENT_VIDEO_ATTACHMENT_BASE64_PAYLOAD_BYTES =
  Math.ceil(MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL / 3) * 4;
const utf8Encoder = new TextEncoder();

export const MAX_AGENT_IPC_ATTACHMENTS = 5;

export interface AgentAttachmentIpcPayload {
  id: string;
  filename: string;
  data: string;
  mimeType: string;
  size: number;
}

export function validateAgentAttachmentIpcPayload(
  attachments: unknown
): { valid: true; value: AgentAttachmentIpcPayload[] } | { valid: false; error: string } {
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_AGENT_IPC_ATTACHMENTS) {
    return { valid: false, error: `Maximum ${MAX_AGENT_IPC_ATTACHMENTS} attachments allowed` };
  }

  let totalSize = 0;
  let videoCount = 0;
  const result: AgentAttachmentIpcPayload[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      return { valid: false, error: 'Invalid attachment entry' };
    }
    const candidate = attachment as Partial<AgentAttachmentIpcPayload>;
    if (typeof candidate.id !== 'string' || typeof candidate.filename !== 'string') {
      return { valid: false, error: 'Attachment must have id and filename' };
    }
    if (typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') {
      return { valid: false, error: 'Attachment must have data and mimeType' };
    }
    if (
      typeof candidate.size !== 'number' ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size <= 0
    ) {
      return { valid: false, error: 'Attachment must have a positive size' };
    }
    if (!ALLOWED_AGENT_ATTACHMENT_IPC_TYPES.has(candidate.mimeType)) {
      return { valid: false, error: `Unsupported attachment type: ${candidate.mimeType}` };
    }

    const isVideo = isAgentVideoMimeType(candidate.mimeType);
    const perAttachmentLimit = isVideo
      ? MAX_AGENT_VIDEO_ATTACHMENT_BYTES
      : MAX_AGENT_ATTACHMENT_IPC_BYTES;
    if (candidate.size > perAttachmentLimit) {
      return {
        valid: false,
        error: `Attachment "${candidate.filename}" exceeds ${isVideo ? '8MB' : '10MB'} limit`,
      };
    }

    const paddingBytes = candidate.data.endsWith('==') ? 2 : candidate.data.endsWith('=') ? 1 : 0;
    const estimatedBinarySize = Math.max(0, Math.ceil(candidate.data.length * 0.75) - paddingBytes);
    if (estimatedBinarySize > perAttachmentLimit * 1.1) {
      return { valid: false, error: `Attachment "${candidate.filename}" data exceeds size limit` };
    }
    if (isVideo && ++videoCount > MAX_AGENT_VIDEO_ATTACHMENTS) {
      return {
        valid: false,
        error: `Maximum ${MAX_AGENT_VIDEO_ATTACHMENTS} video attachment allowed`,
      };
    }

    totalSize += Math.max(candidate.size, estimatedBinarySize);
    result.push({
      id: candidate.id,
      filename: candidate.filename,
      data: candidate.data,
      mimeType: candidate.mimeType,
      size: candidate.size,
    });
  }

  if (videoCount > 0 && totalSize > MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL) {
    return { valid: false, error: 'Video and other attachments exceed the 8MB total size limit' };
  }
  if (totalSize > MAX_AGENT_ATTACHMENT_IPC_BYTES_TOTAL) {
    return { valid: false, error: 'Total attachment size exceeds 20MB limit' };
  }
  return { valid: true, value: result };
}

export function validateAgentAttachmentSerializedIpcPayload(input: {
  text: string;
  attachments: AgentAttachmentIpcPayload[];
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  const includesVideo = input.attachments.some((attachment) =>
    isAgentVideoMimeType(attachment.mimeType)
  );
  const serializedLimit = includesVideo
    ? MAX_AGENT_VIDEO_ATTACHMENT_BASE64_PAYLOAD_BYTES +
      utf8Encoder.encode(JSON.stringify(input.text)).byteLength +
      4096
    : MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES;
  if (estimatedBytes <= serializedLimit) return { valid: true };

  return {
    valid: false,
    error: `Attachment payload is too large after optimization: ${formatBytes(
      estimatedBytes
    )} serialized. Limit is ${formatBytes(
      serializedLimit
    )}. Remove an attachment or use a smaller file.`,
  };
}

export function getAgentVideoAttachmentRecipientRestriction(input: {
  attachments: AgentAttachmentIpcPayload[];
  model?: string;
  providerId: string;
}): string | null {
  const videoAttachments = input.attachments.filter((attachment) =>
    isAgentVideoMimeType(attachment.mimeType)
  );
  if (videoAttachments.length === 0) return null;

  const capability = resolveAgentAttachmentCapability(input);
  if (!capability.supportsVideo) return capability.videoDisplayText;
  return videoAttachments.every((attachment) =>
    capability.supportedVideoMimeTypes.some((mimeType) => mimeType === attachment.mimeType)
  )
    ? null
    : 'This video type is not supported by the selected model.';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
