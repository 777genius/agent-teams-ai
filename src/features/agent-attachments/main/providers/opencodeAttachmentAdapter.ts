import {
  AgentAttachmentError,
  resolveAgentAttachmentCapability,
} from '@features/agent-attachments/core/domain';

import type { AttachmentPayload } from '@shared/types';

export type OpenCodeFilePartMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'video/mp4'
  | 'video/webm'
  | 'video/quicktime';

export interface OpenCodeFilePart {
  type: 'file';
  mime: OpenCodeFilePartMimeType;
  url: string;
  filename: string;
}

export interface OpenCodeAttachmentDeliveryParts {
  kind: 'legacy_text' | 'text_with_file_parts';
  text: string;
  fileParts: OpenCodeFilePart[];
  diagnostics: string[];
}

export interface BuildOpenCodeAttachmentDeliveryPartsInput {
  text: string;
  model: string;
  attachments?: AttachmentPayload[];
}

const OPEN_CODE_IMAGE_MIME_TYPES: readonly OpenCodeFilePartMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

const OPEN_CODE_VIDEO_MIME_TYPES: readonly OpenCodeFilePartMimeType[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

function isOpenCodeImageMimeType(mimeType: string): mimeType is OpenCodeFilePartMimeType {
  return OPEN_CODE_IMAGE_MIME_TYPES.includes(mimeType as OpenCodeFilePartMimeType);
}

function isOpenCodeVideoMimeType(mimeType: string): mimeType is OpenCodeFilePartMimeType {
  return OPEN_CODE_VIDEO_MIME_TYPES.includes(mimeType as OpenCodeFilePartMimeType);
}

function buildOpenCodeCapabilityBlock(
  capability: ReturnType<typeof resolveAgentAttachmentCapability>,
  model: string
): AgentAttachmentError {
  const code =
    capability.reason === 'known_non_vision_model' || capability.reason === 'unknown_model'
      ? 'attachment_model_unsupported'
      : 'attachment_type_unsupported';
  return new AgentAttachmentError(code, capability.displayText, {
    providerId: 'opencode',
    model,
    retryable: false,
    safeDetails: {
      reason: capability.reason,
    },
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}

export function buildOpenCodeAttachmentDeliveryParts(
  input: BuildOpenCodeAttachmentDeliveryPartsInput
): OpenCodeAttachmentDeliveryParts {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return {
      kind: 'legacy_text',
      text: input.text,
      fileParts: [],
      diagnostics: [],
    };
  }

  const capability = resolveAgentAttachmentCapability({
    providerId: 'opencode',
    model: input.model,
  });

  const fileParts: OpenCodeFilePart[] = [];
  const diagnostics: string[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType;

    if (isOpenCodeImageMimeType(mimeType)) {
      if (!capability.supportsImages) {
        throw buildOpenCodeCapabilityBlock(capability, input.model);
      }
      fileParts.push({
        type: 'file',
        mime: mimeType,
        url: `data:${mimeType};base64,${attachment.data}`,
        filename: attachment.filename,
      });
      diagnostics.push(
        `prepared OpenCode image file part ${attachment.filename} (${mimeType}, ${formatBytes(
          attachment.size
        )}) for ${input.model}`
      );
      continue;
    }

    if (isOpenCodeVideoMimeType(mimeType)) {
      if (!capability.supportsVideo) {
        throw new AgentAttachmentError('attachment_type_unsupported', capability.videoDisplayText, {
          providerId: 'opencode',
          model: input.model,
          retryable: false,
          safeDetails: {
            reason: capability.reason,
          },
        });
      }
      fileParts.push({
        type: 'file',
        mime: mimeType,
        url: `data:${mimeType};base64,${attachment.data}`,
        filename: attachment.filename,
      });
      diagnostics.push(
        `prepared OpenCode video file part ${attachment.filename} (${mimeType}, ${formatBytes(
          attachment.size
        )}) for ${input.model}`
      );
      continue;
    }

    throw new AgentAttachmentError(
      'attachment_type_unsupported',
      `OpenCode currently supports ${
        capability.supportsVideo ? 'image and video' : 'image'
      } attachments only; unsupported MIME: ${mimeType}`,
      { providerId: 'opencode', retryable: false }
    );
  }

  return {
    kind: 'text_with_file_parts',
    text: input.text,
    fileParts,
    diagnostics,
  };
}

export function redactOpenCodeFilePartsForDiagnostics(
  parts: OpenCodeFilePart[]
): OpenCodeFilePart[] {
  return parts.map((part) => ({
    ...part,
    url: `[redacted data URL: ${part.mime}]`,
  }));
}
