import React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';

import {
  describeReviewConflictCandidate,
  describeReviewConflictDiscard,
} from '../utils/changeReviewConflicts';

import type { ReviewConflictCandidateSelection } from '../utils/changeReviewConflicts';

interface ChangeReviewConflictDiscardDialogProps {
  pendingDiscard: ReviewConflictCandidateSelection | null;
  resolvingCandidateId: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export const ChangeReviewConflictDiscardDialog = ({
  pendingDiscard,
  resolvingCandidateId,
  onOpenChange,
  onConfirm,
}: ChangeReviewConflictDiscardDialogProps): React.JSX.Element => (
  <AlertDialog open={pendingDiscard !== null} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Discard this recovery branch?</AlertDialogTitle>
        <AlertDialogDescription>
          {describeReviewConflictDiscard(pendingDiscard)} Your current branch stays saved. The
          selected recovery copy will be permanently deleted and cannot be restored later.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={resolvingCandidateId !== null}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          disabled={!pendingDiscard || resolvingCandidateId !== null}
          className="bg-red-600 text-white hover:bg-red-500"
          onClick={() => void onConfirm()}
        >
          Discard recovery branch
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

interface ChangeReviewConflictNoticesProps {
  loadError: string | null;
  refreshPending: boolean;
  activeCandidate: ReviewConflictCandidateSelection | null;
  activeCandidateRecoverable: boolean;
  candidateCount: number;
  resolvingCandidateId: string | null;
  onRetry: () => Promise<void>;
  onRequestDiscard: (candidate: ReviewConflictCandidateSelection) => void;
  onRecover: () => Promise<void>;
}

export const ChangeReviewConflictNotices = ({
  loadError,
  refreshPending,
  activeCandidate,
  activeCandidateRecoverable,
  candidateCount,
  resolvingCandidateId,
  onRetry,
  onRequestDiscard,
  onRecover,
}: ChangeReviewConflictNoticesProps): React.JSX.Element => (
  <>
    {loadError && (
      <div
        role="alert"
        className="flex items-center gap-3 border-b border-red-500/25 bg-red-500/10 px-4 py-2.5 text-xs text-red-200"
      >
        <AlertTriangle className="size-4 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          Recovery copies could not be verified. Review actions stay locked to prevent data loss.
        </div>
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={refreshPending}
          className="shrink-0 rounded border border-red-400/30 px-2.5 py-1.5 hover:bg-red-400/10 disabled:opacity-50"
        >
          Retry recovery check
        </button>
      </div>
    )}

    {activeCandidate && (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-100"
      >
        <AlertTriangle className="size-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">A conflicting recovery branch is safe on disk</div>
          <div className="mt-0.5 text-amber-100/70">
            {describeReviewConflictCandidate(activeCandidate)}
            {candidateCount > 1
              ? ` ${candidateCount - 1} more recovery ${candidateCount === 2 ? 'copy is' : 'copies are'} queued.`
              : ''}
            {activeCandidateRecoverable
              ? ' Switching branches first preserves the current branch as another recovery copy.'
              : ' Review actions remain locked until this incompatible copy is explicitly discarded.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRequestDiscard(activeCandidate)}
          disabled={resolvingCandidateId !== null || refreshPending || loadError !== null}
          className="shrink-0 rounded border border-amber-400/30 px-2.5 py-1.5 text-amber-100 hover:bg-amber-400/10 disabled:opacity-50"
        >
          Discard recovery branch
        </button>
        <button
          type="button"
          onClick={() => void onRecover()}
          disabled={
            !activeCandidateRecoverable ||
            resolvingCandidateId !== null ||
            refreshPending ||
            loadError !== null
          }
          className="shrink-0 rounded bg-amber-400 px-2.5 py-1.5 font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-50"
        >
          Switch to recovery
        </button>
      </div>
    )}
  </>
);
