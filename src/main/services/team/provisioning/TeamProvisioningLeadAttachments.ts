import { createHash } from 'node:crypto';

import {
  buildClaudeAttachmentDeliveryParts,
  buildCodexNativeAttachmentDeliveryParts,
} from '@features/agent-attachments/main';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { AttachmentPayload } from '@shared/types';

/**
 * Deterministic artifact-dir key for a codex-lead attachment delivery. Derived
 * from the run and the composed attachment identities (each attachment.id is a
 * stable uuid assigned once at compose time), so a runtime RETRY of the same
 * send resolves to the SAME on-disk artifact dir instead of leaking a fresh
 * `Date.now()` dir on every attempt. Distinct composes carry distinct
 * attachment ids and therefore still get distinct dirs.
 */
function buildCodexLeadAttachmentMessageId(runId: string, attachments: AttachmentPayload[]): string {
  const identity = attachments.map((attachment) => attachment.id).join(',');
  const digest = createHash('sha256').update(`${runId}\n${identity}`).digest('hex').slice(0, 16);
  return `lead_${runId}_${digest}`;
}

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
  const syncPayload = tryBuildLeadMessageStdinPayloadSync(input);
  if (syncPayload !== null) {
    return syncPayload;
  }
  const content = await buildCodexLeadAttachmentContentBlocks({
    teamName: input.teamName,
    runId: input.runId,
    text: input.text,
    attachments: input.attachments ?? [],
  });
  return stringifyLeadMessageStdinPayload(content);
}

export function tryBuildLeadMessageStdinPayloadSync(
  input: BuildLeadMessageStdinPayloadInput
): string | null {
  const content = tryBuildLeadMessageContentBlocksSync(input);
  return content ? stringifyLeadMessageStdinPayload(content) : null;
}

function stringifyLeadMessageStdinPayload(content: Record<string, unknown>[]): string {
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
  const syncContent = tryBuildLeadMessageContentBlocksSync(input);
  if (syncContent) {
    return syncContent;
  }
  const attachments = input.attachments ?? [];
  return buildCodexLeadAttachmentContentBlocks({
    teamName: input.teamName,
    runId: input.runId,
    text: input.text,
    attachments,
  });
}

export function tryBuildLeadMessageContentBlocksSync(
  input: BuildLeadMessageStdinPayloadInput
): Record<string, unknown>[] | null {
  const attachments = input.attachments ?? [];
  if (normalizeOptionalTeamProviderId(input.providerId) === 'codex' && attachments.length > 0) {
    return null;
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
    messageId: buildCodexLeadAttachmentMessageId(input.runId, input.attachments),
    text: input.text,
    attachments: input.attachments,
  });
  return [
    { type: 'text', text: prepared.promptText },
    ...prepared.imageParts.map((part) => codexImagePartToContentBlock(part)),
  ];
}
