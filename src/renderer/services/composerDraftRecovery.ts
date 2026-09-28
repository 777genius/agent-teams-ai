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

export function createEmptyComposerWorking(address: ComposerDraftAddress): ComposerWorkingRecord {
  return {
    version: 2,
    address,
    workingRevision: '0',
    content: null,
    editorContext: { kind: 'plain' },
    updatedAt: Date.now(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is ComposerDraftAddress {
  if (!isObject(value) || !isObject(value.target)) return false;
  const target = value.target;
  return (
    typeof value.contextId === 'string' &&
    typeof value.teamName === 'string' &&
    (target.kind === 'team-feed' ||
      (target.kind === 'direct' && typeof target.participant === 'string') ||
      (target.kind === 'cross-team' &&
        typeof target.toTeam === 'string' &&
        (target.toMember === null || typeof target.toMember === 'string')))
  );
}

function isEditorContext(value: unknown): value is ComposerEditorContext {
  return (
    isObject(value) &&
    (value.kind === 'plain' ||
      (value.kind === 'revision' &&
        typeof value.originalMessageId === 'string' &&
        typeof value.recipient === 'string' &&
        typeof value.requestId === 'string'))
  );
}

function isContent(value: unknown): value is ComposerDraftContent {
  if (!isObject(value)) return false;
  return (
    typeof value.text === 'string' &&
    (value.actionMode === 'do' || value.actionMode === 'ask' || value.actionMode === 'delegate') &&
    Array.isArray(value.chips) &&
    value.chips.every(
      (chip: unknown) =>
        isObject(chip) &&
        typeof chip.id === 'string' &&
        typeof chip.filePath === 'string' &&
        typeof chip.fileName === 'string' &&
        (chip.fromLine === null || typeof chip.fromLine === 'number') &&
        (chip.toLine === null || typeof chip.toLine === 'number') &&
        typeof chip.codeText === 'string' &&
        typeof chip.language === 'string' &&
        (chip.displayPath === undefined || typeof chip.displayPath === 'string') &&
        (chip.isFolder === undefined || typeof chip.isFolder === 'boolean')
    ) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(
      (attachment: unknown) =>
        isObject(attachment) &&
        typeof attachment.id === 'string' &&
        typeof attachment.filename === 'string' &&
        typeof attachment.mimeType === 'string' &&
        typeof attachment.size === 'number' &&
        typeof attachment.data === 'string' &&
        (attachment.filePath === undefined || typeof attachment.filePath === 'string')
    ) &&
    (value.restoredOrigin === undefined ||
      (isObject(value.restoredOrigin) &&
        value.restoredOrigin.kind === 'unconfirmed-send' &&
        typeof value.restoredOrigin.attemptId === 'string' &&
        (value.restoredOrigin.messageId === undefined ||
          typeof value.restoredOrigin.messageId === 'string')))
  );
}

export function isComposerWorkingRecord(value: unknown): value is ComposerWorkingRecord {
  if (!isObject(value)) return false;
  const candidate = value;
  return (
    candidate.version === 2 &&
    typeof candidate.workingRevision === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    isAddress(candidate.address) &&
    (candidate.content === null || isContent(candidate.content)) &&
    isEditorContext(candidate.editorContext)
  );
}

export function isComposerRecoveryRecord(value: unknown): value is ComposerRecoveryRecord {
  if (!isObject(value)) return false;
  const candidate = value;
  if (!isObject(candidate.snapshot)) return false;
  const snapshot = candidate.snapshot;
  return (
    candidate.version === 2 &&
    typeof candidate.id === 'string' &&
    (candidate.address === null || isAddress(candidate.address)) &&
    isContent(snapshot.content) &&
    isEditorContext(snapshot.editorContext) &&
    (candidate.reason === 'pending-send' ||
      candidate.reason === 'accepted-awaiting-echo' ||
      candidate.reason === 'unconfirmed-send' ||
      candidate.reason === 'not-sent' ||
      candidate.reason === 'displaced-draft' ||
      candidate.reason === 'legacy-draft') &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
}

export function readComposerRecoveryIndex(value: unknown): {
  readonly summaries: ComposerRecoverySummary[];
  readonly unsupported: boolean;
} {
  if (value == null) return { summaries: [], unsupported: false };
  if (!isObject(value) || value.version !== 2 || !Array.isArray(value.summaries)) {
    return { summaries: [], unsupported: true };
  }
  const summaries = value.summaries.flatMap((summary) => {
    if (
      typeof summary !== 'object' ||
      summary === null ||
      typeof (summary as ComposerRecoverySummary).id !== 'string' ||
      typeof (summary as ComposerRecoverySummary).createdAt !== 'number' ||
      typeof (summary as ComposerRecoverySummary).preview !== 'string' ||
      !(
        (summary as ComposerRecoverySummary).address === null ||
        isAddress((summary as ComposerRecoverySummary).address)
      )
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
  return { summaries, unsupported: false };
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
      : { restoredOrigin: undefined }),
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
