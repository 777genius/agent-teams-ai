import React, { useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import { Loader2 } from 'lucide-react';

interface SavedReviewStateRecoveryGateProps {
  decisionStateUnreadable: boolean;
  draftHistoryUnreadable: boolean;
  busy: boolean;
  onRetry: () => void;
  onDiscard: () => Promise<void>;
}

export const SavedReviewStateRecoveryGate = ({
  decisionStateUnreadable,
  draftHistoryUnreadable,
  busy,
  onRetry,
  onDiscard,
}: SavedReviewStateRecoveryGateProps): React.ReactElement | null => {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [discardRunning, setDiscardRunning] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const discardRunningRef = useRef(false);

  if (!decisionStateUnreadable && !draftHistoryUnreadable) return null;

  const failedStateLabels = [
    decisionStateUnreadable ? 'Accept/Reject and Undo/Redo history' : null,
    draftHistoryUnreadable ? 'manual edits and editor Undo history' : null,
  ].filter((label): label is string => label !== null);

  const runDiscard = async (): Promise<void> => {
    if (discardRunningRef.current) return;
    discardRunningRef.current = true;
    setDiscardRunning(true);
    setDiscardError(null);
    try {
      await onDiscard();
      setDiscardConfirmationOpen(false);
    } catch (error) {
      setDiscardError(error instanceof Error ? error.message : String(error));
    } finally {
      discardRunningRef.current = false;
      setDiscardRunning(false);
    }
  };

  return (
    <>
      <div className="flex w-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-red-400">
        <p>Saved review state could not be loaded. The stored copy was left untouched.</p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDiscardError(null);
              setDiscardConfirmationOpen(true);
            }}
            className="border-red-500/30 text-red-300 hover:bg-red-500/10"
          >
            Discard saved state
          </Button>
        </div>
      </div>

      <AlertDialog
        open={discardConfirmationOpen}
        onOpenChange={(nextOpen) => {
          if (!discardRunningRef.current) setDiscardConfirmationOpen(nextOpen);
        }}
      >
        <AlertDialogContent
          data-review-saved-state-discard-confirmation
          onEscapeKeyDown={(event) => {
            if (discardRunning) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Discard saved review recovery data?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the unreadable {failedStateLabels.join(' and ')} for this
              Changes scope. Project files will not be changed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {discardError && <p className="text-xs text-red-300">{discardError}</p>}
          {discardRunning && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              Discarding saved recovery data...
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardRunning}>Keep saved state</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={discardRunning}
              onClick={() => void runDiscard()}
            >
              {discardRunning
                ? 'Discarding...'
                : discardError
                  ? 'Retry discard'
                  : 'Discard forever'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
