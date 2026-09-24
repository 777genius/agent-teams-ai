import { chipToken } from '@renderer/types/inlineChip';
import { truncateChatPreview } from '@renderer/utils/chatPreview';
import { composerDraftAddressKey } from '@renderer/utils/composerDraftIdentity';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';

import type {
  ComposerDraftContent,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
} from '@renderer/types/composerDraft';

function visibleText(content: ComposerDraftContent): string {
  let text = stripEncodedTaskReferenceMetadata(content.text);
  for (const chip of content.chips) {
    text = text.split(chipToken(chip)).join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function hasVisibleDraftContent(content: ComposerDraftContent | null): boolean {
  return (
    content != null &&
    (visibleText(content).length > 0 || content.chips.length > 0 || content.attachments.length > 0)
  );
}

export function composerWorkingSummary(
  record: ComposerWorkingRecord
): ComposerWorkingSummary | null {
  if (!hasVisibleDraftContent(record.content)) return null;
  const content = record.content!;
  return {
    version: 1,
    address: record.address,
    workingRevision: record.workingRevision,
    updatedAt: record.updatedAt,
    preview: truncateChatPreview(visibleText(content)),
    attachmentCount: content.attachments.length,
    chipCount: content.chips.length,
    editorKind: record.editorContext.kind,
  };
}

export function isComposerWorkingSummary(value: unknown): value is ComposerWorkingSummary {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ComposerWorkingSummary>;
  const address = candidate.address as Record<string, unknown> | undefined;
  const target = address?.target as Record<string, unknown> | undefined;
  const targetIsValid =
    target?.kind === 'team-feed' ||
    (target?.kind === 'direct' && typeof target.participant === 'string') ||
    (target?.kind === 'cross-team' &&
      typeof target.toTeam === 'string' &&
      (target.toMember === null || typeof target.toMember === 'string'));
  return (
    candidate.version === 1 &&
    typeof candidate.workingRevision === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    Number.isFinite(new Date(candidate.updatedAt).getTime()) &&
    typeof candidate.preview === 'string' &&
    typeof candidate.attachmentCount === 'number' &&
    typeof candidate.chipCount === 'number' &&
    (candidate.editorKind === 'plain' || candidate.editorKind === 'revision') &&
    typeof address?.contextId === 'string' &&
    typeof address.teamName === 'string' &&
    targetIsValid
  );
}

export function readComposerWorkingIndex(value: unknown): {
  readonly summaries: ComposerWorkingSummary[];
  readonly unsupported: boolean;
} {
  if (value == null) return { summaries: [], unsupported: false };
  if (typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return { summaries: [], unsupported: true };
  }
  const raw = (value as { summaries?: unknown }).summaries;
  if (!Array.isArray(raw)) return { summaries: [], unsupported: true };
  const byAddress = new Map<string, ComposerWorkingSummary>();
  for (const summary of raw) {
    if (!isComposerWorkingSummary(summary)) continue;
    byAddress.set(composerDraftAddressKey(summary.address), summary);
  }
  return { summaries: [...byAddress.values()], unsupported: false };
}

export function upsertComposerWorkingSummary(
  summaries: readonly ComposerWorkingSummary[],
  summary: ComposerWorkingSummary
): ComposerWorkingSummary[] {
  const key = composerDraftAddressKey(summary.address);
  return [
    summary,
    ...summaries.filter((candidate) => composerDraftAddressKey(candidate.address) !== key),
  ];
}

export function removeComposerWorkingSummary(
  summaries: readonly ComposerWorkingSummary[],
  address: ComposerWorkingRecord['address']
): ComposerWorkingSummary[] {
  const key = composerDraftAddressKey(address);
  return summaries.filter((candidate) => composerDraftAddressKey(candidate.address) !== key);
}
