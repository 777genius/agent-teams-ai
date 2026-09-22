import { sameComposerDraftAddress } from '@renderer/utils/composerDraftIdentity';

import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerEditorContext,
  ComposerRecoveryRecord,
  ComposerRecoverySummary,
  ComposerWorkingRecord,
} from '@renderer/types/composerDraft';

let revisionSerial = 0;

export function createComposerWorkingRevision(label = 'working'): string {
  revisionSerial += 1;
  return `${label}:${Date.now().toString(36)}:${revisionSerial.toString(36)}`;
}

export function createEmptyComposerWorking(
  address: ComposerDraftAddress
): ComposerWorkingRecord {
  return {
    version: 2,
    address,
    workingRevision: '0',
    content: null,
    editorContext: { kind: 'plain' },
    updatedAt: Date.now(),
  };
}

export function isComposerWorkingRecord(value: unknown): value is ComposerWorkingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const address = candidate.address as Record<string, unknown> | undefined;
  return (
    candidate.version === 2 &&
    typeof candidate.workingRevision === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    typeof address?.contextId === 'string' &&
    typeof address.teamName === 'string' &&
    typeof address.target === 'object' &&
    (candidate.content === null || typeof candidate.content === 'object') &&
    typeof candidate.editorContext === 'object'
  );
}

export function isComposerRecoveryRecord(value: unknown): value is ComposerRecoveryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const snapshot = candidate.snapshot as Record<string, unknown> | undefined;
  return (
    candidate.version === 2 &&
    typeof candidate.id === 'string' &&
    typeof snapshot?.content === 'object' &&
    typeof snapshot.editorContext === 'object' &&
    typeof candidate.reason === 'string'
  );
}

export function readComposerRecoveryIndex(value: unknown): ComposerRecoverySummary[] {
  if (typeof value !== 'object' || value === null) return [];
  const summaries = (value as { version?: unknown; summaries?: unknown }).summaries;
  if ((value as { version?: unknown }).version !== 2 || !Array.isArray(summaries)) return [];
  return summaries.flatMap((summary) => {
    if (
      typeof summary !== 'object' ||
      summary === null ||
      typeof (summary as ComposerRecoverySummary).id !== 'string' ||
      typeof (summary as ComposerRecoverySummary).createdAt !== 'number' ||
      typeof (summary as ComposerRecoverySummary).preview !== 'string'
    ) {
      return [];
    }
    const candidate = summary as ComposerRecoverySummary;
    return [
      {
        ...candidate,
        updatedAt:
          typeof candidate.updatedAt === 'number' ? candidate.updatedAt : candidate.createdAt,
      },
    ];
  });
}

export function composerRecoverySummary(record: ComposerRecoveryRecord): ComposerRecoverySummary {
  return {
    id: record.id,
    address: record.address,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    reason: record.reason,
    preview: record.snapshot.content.text.slice(0, 120),
    legacy: record.reason === 'legacy-draft',
  };
}

export function upsertComposerRecoverySummary(
  summaries: readonly ComposerRecoverySummary[],
  summary: ComposerRecoverySummary
): ComposerRecoverySummary[] {
  return [summary, ...summaries.filter((candidate) => candidate.id !== summary.id)].sort(
    (left, right) => right.createdAt - left.createdAt
  );
}

export function removeComposerRecoverySummary(
  summaries: readonly ComposerRecoverySummary[],
  id: string
): ComposerRecoverySummary[] {
  return summaries.filter((summary) => summary.id !== id);
}

export type BuildRestoredWorkingResult =
  | { readonly kind: 'working'; readonly working: ComposerWorkingRecord }
  | { readonly kind: 'blocked'; readonly error: string };

export function buildRestoredWorking(
  source: ComposerRecoveryRecord,
  destination: ComposerDraftAddress,
  workingRevision: string,
  asNewMessage: boolean
): BuildRestoredWorkingResult {
  let editorContext: ComposerEditorContext = source.snapshot.editorContext;
  if (
    editorContext.kind === 'revision' &&
    source.address != null &&
    !sameComposerDraftAddress(source.address, destination)
  ) {
    if (!asNewMessage) {
      return {
        kind: 'blocked',
        error: 'A correction can only move to another recipient as a new message.',
      };
    }
    editorContext = { kind: 'plain' };
  }
  const content: ComposerDraftContent = {
    ...source.snapshot.content,
    ...(source.reason === 'pending-send' || source.reason === 'unconfirmed-send'
      ? {
          restoredOrigin: {
            kind: 'unconfirmed-send' as const,
            attemptId: source.id,
            ...(source.outcome?.kind !== 'not-sent' && source.outcome?.messageId
              ? { messageId: source.outcome.messageId }
              : {}),
          },
        }
      : {}),
  };
  return {
    kind: 'working',
    working: {
      version: 2,
      address: destination,
      workingRevision,
      content,
      editorContext,
      updatedAt: Date.now(),
    },
  };
}
