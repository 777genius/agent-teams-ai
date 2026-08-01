import {
  AgentAttachmentError,
  isAgentVideoMimeType,
  isNativeImageMimeType,
  resolveAgentAttachmentCapability,
  validateAttachmentBatchForCapability,
} from '@features/agent-attachments/core/domain';

import type {
  AttachmentValidationResult,
  NativeAgentAttachmentMimeType,
} from '@features/agent-attachments/core/domain';
import type { AttachmentPayload } from '@shared/types';

export type OpenCodeFilePartMimeType = NativeAgentAttachmentMimeType;

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

function isOpenCodeImageMimeType(mimeType: string): mimeType is OpenCodeFilePartMimeType {
  return isNativeImageMimeType(mimeType);
}

function isOpenCodeVideoMimeType(mimeType: string): mimeType is OpenCodeFilePartMimeType {
  return isAgentVideoMimeType(mimeType);
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

function invalidPayload(attachment: AttachmentPayload, message: string): AgentAttachmentError {
  return new AgentAttachmentError('attachment_provider_rejected', message, {
    providerId: 'opencode',
    attachmentId: attachment.id,
    retryable: false,
  });
}

function hasCanonicalBase64Syntax(data: string): boolean {
  const paddingLength = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - paddingLength;
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit && code !== 43 && code !== 47) return false;
  }
  return true;
}

function decodeAttachmentByteLength(
  attachment: AttachmentPayload,
  maxDecodedBytes: number
): number {
  if (
    typeof attachment.data !== 'string' ||
    attachment.data.length === 0 ||
    attachment.data.length % 4 !== 0
  ) {
    throw invalidPayload(attachment, `Attachment ${attachment.filename} has invalid base64 data.`);
  }

  const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4;
  if (attachment.data.length > maxEncodedLength) {
    throw new AgentAttachmentError(
      'attachment_too_large',
      `Attachment ${attachment.filename} is too large for the selected provider path.`,
      { providerId: 'opencode', attachmentId: attachment.id, retryable: false }
    );
  }
  if (!hasCanonicalBase64Syntax(attachment.data)) {
    throw invalidPayload(attachment, `Attachment ${attachment.filename} has invalid base64 data.`);
  }

  const decoded = Buffer.from(attachment.data, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== attachment.data) {
    throw invalidPayload(attachment, `Attachment ${attachment.filename} has invalid base64 data.`);
  }
  if (decoded.length > maxDecodedBytes) {
    throw new AgentAttachmentError(
      'attachment_too_large',
      `Attachment ${attachment.filename} is too large for the selected provider path.`,
      { providerId: 'opencode', attachmentId: attachment.id, retryable: false }
    );
  }
  if (!Number.isSafeInteger(attachment.size) || attachment.size !== decoded.length) {
    throw invalidPayload(
      attachment,
      `Attachment ${attachment.filename} declared byte size does not match its data.`
    );
  }
  return decoded.length;
}

function throwValidationFailure(
  result: Exclude<AttachmentValidationResult, { ok: true }>,
  input: BuildOpenCodeAttachmentDeliveryPartsInput
): never {
  throw new AgentAttachmentError(result.code, result.message, {
    providerId: 'opencode',
    model: input.model,
    retryable: false,
  });
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

  const preparedAttachments: {
    attachment: AttachmentPayload;
    mimeType: OpenCodeFilePartMimeType;
    kind: 'image' | 'video';
    sizeBytes: number;
  }[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType;
    if (isOpenCodeImageMimeType(mimeType)) {
      if (!capability.supportsImages) {
        throw buildOpenCodeCapabilityBlock(capability, input.model);
      }
      preparedAttachments.push({
        attachment,
        mimeType,
        kind: 'image',
        sizeBytes: decodeAttachmentByteLength(
          attachment,
          Math.min(capability.maxBytesPerImage, capability.maxBytesTotal)
        ),
      });
      continue;
    }
    if (isOpenCodeVideoMimeType(mimeType)) {
      if (!capability.supportsVideo) {
        throw new AgentAttachmentError('attachment_type_unsupported', capability.videoDisplayText, {
          providerId: 'opencode',
          model: input.model,
          retryable: false,
          safeDetails: { reason: capability.reason },
        });
      }
      preparedAttachments.push({
        attachment,
        mimeType,
        kind: 'video',
        sizeBytes: decodeAttachmentByteLength(
          attachment,
          Math.min(capability.maxBytesPerVideo, capability.maxBytesTotal)
        ),
      });
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

  const validation = validateAttachmentBatchForCapability({
    attachments: preparedAttachments,
    capability,
  });
  if (!validation.ok) throwValidationFailure(validation, input);

  const fileParts: OpenCodeFilePart[] = [];
  const diagnostics: string[] = [];
  for (const prepared of preparedAttachments) {
    const { attachment, mimeType, kind, sizeBytes } = prepared;
    fileParts.push({
      type: 'file',
      mime: mimeType,
      url: `data:${mimeType};base64,${attachment.data}`,
      filename: attachment.filename,
    });
    diagnostics.push(
      `prepared OpenCode ${kind} file part ${attachment.filename} (${mimeType}, ${formatBytes(
        sizeBytes
      )}) for ${input.model}`
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
