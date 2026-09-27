import { chipToken } from '@renderer/types/inlineChip';
import { truncateChatPreview } from '@renderer/utils/chatPreview';
import { composerDraftAddressKey } from '@renderer/utils/composerDraftIdentity';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';

import type {
  ComposerDraftAddress,
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

export function workingIndexRecord(summaries: readonly ComposerWorkingSummary[]): {
  readonly version: 1;
  readonly summaries: readonly ComposerWorkingSummary[];
} {
  return { version: 1, summaries };
}

export function nextWorkingSummaries(
  rawIndex: unknown,
  address: ComposerDraftAddress,
  record: ComposerWorkingRecord | null
): ComposerWorkingSummary[] | null {
  const current = readComposerWorkingIndex(rawIndex);
  if (current.unsupported) return null;
  const summary = record ? composerWorkingSummary(record) : null;
  return summary
    ? upsertComposerWorkingSummary(current.summaries, summary)
    : removeComposerWorkingSummary(current.summaries, address);
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

export function mergePrimedWorkingDrafts(
  currentSummaries: readonly ComposerWorkingSummary[],
  primedSummaries: readonly ComposerWorkingSummary[],
  primedRecords: readonly (readonly [string, ComposerWorkingRecord] | null)[],
  memoryWorking: Map<string, ComposerWorkingRecord>,
  changedAt: ReadonlyMap<string, number>,
  startedAt: number,
  unchanged: boolean
): ComposerWorkingSummary[] {
  let merged = unchanged ? [] : [...currentSummaries];
  const present = new Set(
    primedSummaries.map((summary) => composerDraftAddressKey(summary.address))
  );
  for (const summary of currentSummaries) {
    const key = composerDraftAddressKey(summary.address);
    if (present.has(key) || (changedAt.get(key) ?? 0) > startedAt) continue;
    merged = removeComposerWorkingSummary(merged, summary.address);
    const record = memoryWorking.get(key);
    if (record && composerWorkingSummary(record)) memoryWorking.delete(key);
  }
  for (let index = 0; index < primedSummaries.length; index += 1) {
    const summary = primedSummaries[index];
    const key = composerDraftAddressKey(summary.address);
    if (!unchanged && (changedAt.get(key) ?? 0) > startedAt) continue;
    merged = upsertComposerWorkingSummary(merged, summary);
    const record = primedRecords[index];
    if (record) memoryWorking.set(...record);
  }
  return merged;
}

function removeAbsentWorkingRecords(
  records: Map<string, ComposerWorkingRecord>,
  summaries: readonly ComposerWorkingSummary[],
  changedAt: ReadonlyMap<string, number>,
  startedAt: number,
  contextId: string,
  teamName: string
): void {
  const present = new Set(summaries.map((summary) => composerDraftAddressKey(summary.address)));
  for (const [key, record] of records) {
    if (record.address.contextId !== contextId || record.address.teamName !== teamName) continue;
    if (
      !present.has(key) &&
      composerWorkingSummary(record) &&
      (changedAt.get(key) ?? 0) <= startedAt
    )
      records.delete(key);
  }
}

export function refreshWorkingIndexSnapshot(
  current: readonly ComposerWorkingSummary[],
  incoming: readonly ComposerWorkingSummary[],
  records: Map<string, ComposerWorkingRecord>,
  changedAt: ReadonlyMap<string, number>,
  startedAt: number,
  unchanged: boolean,
  contextId: string,
  teamName: string
): ComposerWorkingSummary[] {
  const merged = mergePrimedWorkingDrafts(
    current,
    incoming,
    [],
    records,
    changedAt,
    startedAt,
    unchanged
  );
  removeAbsentWorkingRecords(records, merged, changedAt, startedAt, contextId, teamName);
  return merged;
}

export function needsHydration(
  summaries: readonly ComposerWorkingSummary[],
  records: ReadonlyMap<string, ComposerWorkingRecord>
): boolean {
  return summaries.some(
    (summary) =>
      records.get(composerDraftAddressKey(summary.address))?.workingRevision !==
      summary.workingRevision
  );
}

export function removeComposerWorkingSummary(
  summaries: readonly ComposerWorkingSummary[],
  address: ComposerWorkingRecord['address']
): ComposerWorkingSummary[] {
  const key = composerDraftAddressKey(address);
  return summaries.filter((candidate) => composerDraftAddressKey(candidate.address) !== key);
}

export function sameComposerWorkingSummary(
  left: ComposerWorkingSummary | undefined,
  right: ComposerWorkingSummary | null
): boolean {
  if (!left || !right) return left == null && right == null;
  return (
    left.workingRevision === right.workingRevision &&
    left.updatedAt === right.updatedAt &&
    left.preview === right.preview &&
    left.attachmentCount === right.attachmentCount &&
    left.chipCount === right.chipCount &&
    left.editorKind === right.editorKind
  );
}
