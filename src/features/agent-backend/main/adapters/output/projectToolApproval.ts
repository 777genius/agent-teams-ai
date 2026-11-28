import { readBackendAttachmentChunk } from '../../../contracts/attachments';
import { readBackendToolApprovalSettings } from '../../../contracts/toolApprovals';

import type {
  BackendInteractionPreview,
  BackendToolApprovalSettingsView,
} from '../../../contracts/toolApprovals';

function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid approval projection');
  return value as Record<string, unknown>;
}
export function projectToolApprovalSettings(value: unknown): BackendToolApprovalSettingsView {
  return { settings: readBackendToolApprovalSettings(row(value, ['settings']).settings) };
}
export function projectInteractionPreview(
  value: unknown,
  input: { offset: number; expectedSha256?: string; expectedSource?: string }
): BackendInteractionPreview {
  const source = row(value, ['file', 'sourceFingerprint', 'exists', 'truncated', 'isBinary']);
  if (
    typeof source.sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sourceFingerprint) ||
    (input.expectedSource !== undefined && source.sourceFingerprint !== input.expectedSource) ||
    typeof source.exists !== 'boolean' ||
    typeof source.truncated !== 'boolean' ||
    typeof source.isBinary !== 'boolean' ||
    ((!source.exists || source.isBinary) && (source.file !== null || source.truncated))
  )
    throw new Error('Invalid interaction preview');
  const file = readBackendAttachmentChunk(source.file, { ...input, attachmentId: 'preview' });
  if (
    source.exists &&
    !source.isBinary &&
    (!file ||
      file.attachment.size > 2 * 1024 * 1024 ||
      file.attachment.filename !== 'preview' ||
      file.attachment.mimeType !== 'text/plain')
  )
    throw new Error('Invalid interaction preview');
  return {
    file,
    sourceFingerprint: source.sourceFingerprint,
    exists: source.exists,
    truncated: source.truncated,
    isBinary: source.isBinary,
  };
}
