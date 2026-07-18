import type { ReviewActionIntent, ReviewUndoAction } from '@shared/types';

export type ReviewActionTone = 'accept' | 'reject' | 'restore' | 'neutral';

export interface ReviewActionPresentation {
  title: string;
  detail: string | null;
  tone: ReviewActionTone;
}

const INTENT_PRESENTATION: Record<
  ReviewActionIntent,
  Pick<ReviewActionPresentation, 'title' | 'tone'>
> = {
  'accept-hunk': { title: 'Accept hunk', tone: 'accept' },
  'reject-hunk': { title: 'Reject hunk', tone: 'reject' },
  'accept-file': { title: 'Accept file', tone: 'accept' },
  'reject-file': { title: 'Reject file', tone: 'reject' },
  'accept-all': { title: 'Accept all', tone: 'accept' },
  'reject-all': { title: 'Reject all', tone: 'reject' },
  'restore-file': { title: 'Restore file', tone: 'restore' },
  'restore-rename': { title: 'Restore rename', tone: 'restore' },
};

export type ReviewFileLabelResolver = (filePath: string) => string;

function fileDetail(
  filePath: string | undefined,
  hunkIndex?: number,
  resolveFileLabel?: ReviewFileLabelResolver
): string | null {
  if (!filePath) return hunkIndex === undefined ? null : `Hunk ${hunkIndex + 1}`;
  const fileLabel = resolveFileLabel?.(filePath) || filePath;
  return hunkIndex === undefined ? fileLabel : `${fileLabel} · hunk ${hunkIndex + 1}`;
}

function describeLegacyReviewAction(
  action: ReviewUndoAction,
  resolveFileLabel?: ReviewFileLabelResolver
): ReviewActionPresentation {
  if (action.kind === 'hunk') {
    return {
      title: 'Review hunk',
      detail: fileDetail(action.action.filePath, action.action.originalIndex, resolveFileLabel),
      tone: 'neutral',
    };
  }
  if (action.kind === 'disk') {
    return {
      title: action.action.originalIndex === undefined ? 'File review change' : 'Review hunk',
      detail: fileDetail(
        action.action.snapshot.filePath,
        action.action.originalIndex,
        resolveFileLabel
      ),
      tone: 'neutral',
    };
  }
  return {
    title: 'Bulk review change',
    detail:
      action.diskSnapshots.length > 0
        ? `${action.diskSnapshots.length} file${action.diskSnapshots.length === 1 ? '' : 's'}`
        : null,
    tone: 'neutral',
  };
}

export function describeReviewAction(
  action: ReviewUndoAction,
  resolveFileLabel?: ReviewFileLabelResolver
): ReviewActionPresentation {
  const descriptor = action.descriptor;
  if (!descriptor) return describeLegacyReviewAction(action, resolveFileLabel);
  const presentation = INTENT_PRESENTATION[descriptor.intent];
  const detail =
    'fileCount' in descriptor
      ? `${descriptor.fileCount} file${descriptor.fileCount === 1 ? '' : 's'}`
      : fileDetail(
          descriptor.filePath,
          'hunkIndex' in descriptor ? descriptor.hunkIndex : undefined,
          resolveFileLabel
        );
  return { ...presentation, detail };
}

/** Returns the stack top first without cloning an unbounded durable history. */
export function takeRecentReviewActions(
  actions: readonly ReviewUndoAction[],
  limit: number
): ReviewUndoAction[] {
  const recent: ReviewUndoAction[] = [];
  const safeLimit = Math.max(0, Math.floor(limit));
  for (let index = actions.length - 1; index >= 0 && recent.length < safeLimit; index--) {
    recent.push(actions[index]!);
  }
  return recent;
}
