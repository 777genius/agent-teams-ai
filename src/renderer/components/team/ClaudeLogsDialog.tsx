/**
 * ClaudeLogsDialog
 *
 * Fullscreen-style dialog for viewing Claude logs in a large viewport.
 * Uses the same ClaudeLogsPanel as the compact sidebar but with more space.
 * Only one CliLogsRichView is mounted at a time — when this dialog is open,
 * the compact panel hides its log viewer.
 */

import React from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { Terminal } from 'lucide-react';

import { ClaudeLogsPanel } from './ClaudeLogsPanel';

import type { ClaudeLogsController } from './useClaudeLogsController';

// =============================================================================
// Props
// =============================================================================

interface ClaudeLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ctrl: ClaudeLogsController;
}

// =============================================================================
// Component
// =============================================================================

export const ClaudeLogsDialog = ({
  open,
  onOpenChange,
  ctrl,
}: ClaudeLogsDialogProps): React.JSX.Element => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[80vw] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="inline-flex size-5 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] shadow-sm">
              <Terminal size={12} />
            </span>
            Claude logs
            {ctrl.badge != null && (
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                ({ctrl.badge})
              </span>
            )}
            {ctrl.online && (
              <span className="pointer-events-none relative inline-flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ClaudeLogsPanel
            ctrl={ctrl}
            viewerClassName="max-h-full h-full"
            className="flex h-full flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
