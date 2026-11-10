import { AgentAttachmentError } from '@features/agent-attachments/core/domain';
import {
  type AgentAttachmentArtifactFileName,
  resolveAgentAttachmentArtifactPath,
  writeFileAtomic,
} from '@features/agent-attachments/main/infrastructure/attachmentArtifactStore';

import type { AttachmentPayload } from '@shared/types';

export type CodexNativeImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface CodexNativeImageArgPart {
  kind: 'codex-image-arg';
  attachmentId: string;
  filename: string;
  mimeType: CodexNativeImageMimeType;
  path: string;
  sizeBytes: number;
}

export interface CodexNativeAttachmentDeliveryParts {
  kind: 'legacy_text' | 'text_with_images';
  promptText: string;
  imageParts: CodexNativeImageArgPart[];
  diagnostics: string[];
}

export interface BuildCodexNativeAttachmentDeliveryPartsInput {
  teamName: string;
  messageId: string;
  text: string;
  attachments?: AttachmentPayload[];
  appDataPath?: string;
}

function assertCodexImageMimeType(mimeType: string): asserts mimeType is CodexNativeImageMimeType {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') {
    return;
  }

  throw new AgentAttachmentError(
    'attachment_type_unsupported',
    `Codex native supports image attachments only; unsupported MIME: ${mimeType}`,
    { retryable: false }
  );
}

function codexArtifactFileName(
  mimeType: CodexNativeImageMimeType
): AgentAttachmentArtifactFileName {
  switch (mimeType) {
    case 'image/png':
      return 'optimized.png';
    case 'image/jpeg':
      return 'optimized.jpg';
    case 'image/webp':
      return 'optimized.webp';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}

export async function buildCodexNativeAttachmentDeliveryParts(
  input: BuildCodexNativeAttachmentDeliveryPartsInput
): Promise<CodexNativeAttachmentDeliveryParts> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return {
      kind: 'legacy_text',
      promptText: input.text,
      imageParts: [],
      diagnostics: [],
    };
  }

  const imageParts: CodexNativeImageArgPart[] = [];
  const diagnostics: string[] = [];

  for (const attachment of attachments) {
    assertCodexImageMimeType(attachment.mimeType);

    const filePath = resolveAgentAttachmentArtifactPath({
      teamName: input.teamName,
      messageId: input.messageId,
      attachmentId: attachment.id,
      fileName: codexArtifactFileName(attachment.mimeType),
      appDataPath: input.appDataPath,
    });
    const bytes = Buffer.from(attachment.data, 'base64');
    await writeFileAtomic(filePath, bytes);

    imageParts.push({
      kind: 'codex-image-arg',
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      path: filePath,
      sizeBytes: bytes.byteLength,
    });
    diagnostics.push(
      `prepared Codex native image ${attachment.filename} (${attachment.mimeType}, ${formatBytes(
        bytes.byteLength
      )})`
    );
  }

  return {
    kind: 'text_with_images',
    promptText: input.text,
    imageParts,
    diagnostics,
  };
}

export function redactCodexNativeAttachmentPartsForDiagnostics(
  parts: CodexNativeImageArgPart[]
): (Omit<CodexNativeImageArgPart, 'path'> & { path: string })[] {
  return parts.map((part) => ({
    ...part,
    path: `[managed attachment artifact: ${part.filename}]`,
  }));
}
