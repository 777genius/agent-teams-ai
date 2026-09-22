import type { ComposerRecoveryRecord } from '@renderer/types/composerDraft';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode, AttachmentPayload } from '@shared/types';

interface LegacySnapshot {
  readonly text: string;
  readonly chips: InlineChip[];
  readonly attachments: AttachmentPayload[];
  readonly actionMode: AgentActionMode;
}

export const LEGACY_UNIFIED_RECOVERY_ID = 'legacy:unified';
export const LEGACY_SPLIT_RECOVERY_ID = 'legacy:split';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLegacyText(value: unknown): string {
  return isObject(value) && typeof value.value === 'string' ? value.value : '';
}

function parseLegacyArray<T>(value: unknown, validate: (candidate: unknown) => candidate is T[]): T[] {
  try {
    const unwrapped = isObject(value) && 'value' in value ? value.value : value;
    const parsed = typeof unwrapped === 'string' ? (JSON.parse(unwrapped) as unknown) : unwrapped;
    return validate(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isChipArray(value: unknown): value is InlineChip[] {
  return Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string');
}

function isAttachmentArray(value: unknown): value is AttachmentPayload[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isObject(item) &&
        typeof item.id === 'string' &&
        typeof item.filename === 'string' &&
        typeof item.data === 'string'
    )
  );
}

export function decodeUnifiedLegacy(value: unknown): LegacySnapshot | null {
  if (!isObject(value) || value.version !== 1 || typeof value.text !== 'string') return null;
  if (!isChipArray(value.chips) || !isAttachmentArray(value.attachments)) return null;
  return {
    text: value.text,
    chips: value.chips,
    attachments: value.attachments,
    actionMode:
      value.actionMode === 'ask' || value.actionMode === 'delegate' ? value.actionMode : 'do',
  };
}

export function decodeSplitLegacy(values: readonly unknown[]): LegacySnapshot | null {
  const snapshot: LegacySnapshot = {
    text: parseLegacyText(values[0]),
    chips: parseLegacyArray(values[1], isChipArray),
    attachments: parseLegacyArray(values[2], isAttachmentArray),
    actionMode: 'do',
  };
  return snapshot.text || snapshot.chips.length || snapshot.attachments.length ? snapshot : null;
}

export function createLegacyRecoveryRecord(
  id: string,
  snapshot: LegacySnapshot,
  updatedAt = Date.now()
): ComposerRecoveryRecord {
  return {
    version: 2,
    id,
    address: null,
    snapshot: { content: { ...snapshot }, editorContext: { kind: 'plain' } },
    preparedRequest: null,
    reason: 'legacy-draft',
    createdAt: updatedAt,
    updatedAt,
  };
}
