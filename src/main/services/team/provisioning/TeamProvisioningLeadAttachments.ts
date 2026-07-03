import {
  buildClaudeAttachmentDeliveryParts,
  buildCodexNativeAttachmentDeliveryParts,
} from '@features/agent-attachments/main';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { AttachmentPayload } from '@shared/types';

export interface LeadAttachmentInput {
  data: string;
  mimeType: string;
  filename?: string;
}

export interface CodexNativeImagePartLike {
  path: string;
  mimeType: string;
}

export interface BuildLeadMessageStdinPayloadInput {
  teamName: string;
  runId: string;
  providerId?: unknown;
  text: string;
  attachments?: AttachmentPayload[];
}

export function toLeadAttachmentPayloads(
  attachments?: readonly LeadAttachmentInput[]
): AttachmentPayload[] {
  return (attachments ?? []).map((attachment, index) => {
    const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
    const bytes = Buffer.from(attachment.data, 'base64');
    return {
      id: `lead_att_${index + 1}`,
      filename,
      mimeType: attachment.mimeType,
      size: bytes.byteLength,
      data: attachment.data,
    };
  });
}

export function codexImagePartToContentBlock(
  part: CodexNativeImagePartLike
): Record<string, unknown> {
  return {
    type: 'image',
    source: {
      type: 'file',
      path: part.path,
      media_type: part.mimeType,
    },
  };
}

export async function buildLeadMessageStdinPayload(
  input: BuildLeadMessageStdinPayloadInput
): Promise<string> {
  const content = await buildLeadMessageContentBlocks(input);
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
}

export async function buildLeadMessageContentBlocks(
  input: BuildLeadMessageStdinPayloadInput
): Promise<Record<string, unknown>[]> {
  const attachments = input.attachments ?? [];
  if (normalizeOptionalTeamProviderId(input.providerId) === 'codex' && attachments.length > 0) {
    return buildCodexLeadAttachmentContentBlocks({
      teamName: input.teamName,
      runId: input.runId,
      text: input.text,
      attachments,
    });
  }

  return buildClaudeLeadAttachmentContentBlocks({
    text: input.text,
    attachments,
  });
}

export function buildClaudeLeadAttachmentContentBlocks(input: {
  text: string;
  attachments?: AttachmentPayload[];
}): Record<string, unknown>[] {
  return buildClaudeAttachmentDeliveryParts(input).blocks as Record<string, unknown>[];
}

export async function buildCodexLeadAttachmentContentBlocks(input: {
  teamName: string;
  runId: string;
  text: string;
  attachments: AttachmentPayload[];
}): Promise<Record<string, unknown>[]> {
  const prepared = await buildCodexNativeAttachmentDeliveryParts({
    teamName: input.teamName,
    messageId: `lead_${input.runId}_${Date.now()}`,
    text: input.text,
    attachments: input.attachments,
  });
  return [
    { type: 'text', text: prepared.promptText },
    ...prepared.imageParts.map((part) => codexImagePartToContentBlock(part)),
  ];
}
