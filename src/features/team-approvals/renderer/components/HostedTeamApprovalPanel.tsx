import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { Check, Loader2, RefreshCw, ShieldAlert, X } from 'lucide-react';

import type { HostedTeamApprovalId, HostedTeamApprovalItem } from '../../contracts';
import type { HostedTeamApprovalRendererSlice } from '../ports/HostedTeamApprovalRendererPorts';

export interface HostedTeamApprovalPanelProps {
  readonly slice: HostedTeamApprovalRendererSlice;
  readonly heading?: string;
  readonly description?: string;
  /** Read and preview stay mounted when mutation readiness is unavailable. */
  readonly decisionsEnabled?: boolean;
}

function categoryLabel(category: HostedTeamApprovalItem['category']): string {
  switch (category) {
    case 'file_change':
      return 'File change';
    case 'command':
      return 'Command';
    case 'network':
      return 'Network';
    case 'other':
      return 'Other';
  }
}

export const HostedTeamApprovalPanel = ({
  slice,
  heading = 'Pending approvals',
  description = 'Review provider requests before allowing or denying them.',
  decisionsEnabled = true,
}: HostedTeamApprovalPanelProps): React.JSX.Element => {
  const snapshot = useSyncExternalStore(slice.subscribe, slice.getSnapshot, slice.getSnapshot);
  const headingId = useId();
  const descriptionId = useId();
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef(new Map<HostedTeamApprovalId, HTMLButtonElement>());
  const appliedFocus = useRef({ slice, sequence: 0 });

  useEffect(() => slice.mount(), [slice]);

  useLayoutEffect(() => {
    if (appliedFocus.current.slice !== slice) {
      appliedFocus.current = { slice, sequence: 0 };
    }
    const request = snapshot.focusRequest;
    if (request === null || request.sequence <= appliedFocus.current.sequence) return;
    appliedFocus.current = { slice, sequence: request.sequence };
    const target =
      request.approvalId === null
        ? refreshButtonRef.current
        : itemRefs.current.get(request.approvalId);
    target?.focus();
  }, [slice, snapshot.focusRequest]);

  const selectedItem = snapshot.items.find(
    (item) => item.approvalId === snapshot.selectedApprovalId
  );
  const selectedIsPending =
    selectedItem !== undefined &&
    snapshot.pendingDecision?.approvalId === selectedItem.approvalId &&
    snapshot.pendingDecision.generation === selectedItem.generation;

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert aria-hidden="true" className="size-4 text-amber-500" />
            <h2 id={headingId} className="text-sm font-semibold text-[var(--color-text)]">
              {heading}
            </h2>
          </div>
          <p id={descriptionId} className="mt-1 text-xs text-[var(--color-text-muted)]">
            {description}
          </p>
        </div>

        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={refreshButtonRef}
                type="button"
                variant="outline"
                size="icon"
                aria-label="Refresh approvals"
                disabled={snapshot.pageStatus === 'loading'}
                onClick={() => void slice.reload()}
              >
                {snapshot.pageStatus === 'loading' ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh approvals</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0">
          {snapshot.pageStatus === 'loading' && snapshot.items.length === 0 ? (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
            >
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Loading approvals…
            </p>
          ) : null}

          {snapshot.pageError !== null ? (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500"
            >
              {snapshot.pageError}
            </p>
          ) : null}

          {snapshot.pageStatus === 'ready' && snapshot.items.length === 0 ? (
            <p className="rounded-md bg-[var(--color-surface-raised)] p-3 text-sm text-[var(--color-text-muted)]">
              There are no pending approvals.
            </p>
          ) : null}

          {snapshot.items.length > 0 ? (
            <ul aria-label="Pending approval requests" className="space-y-2">
              {snapshot.items.map((item) => {
                const selected = item.approvalId === snapshot.selectedApprovalId;
                return (
                  <li key={`${item.approvalId}:${item.generation}`}>
                    <Button
                      ref={(node) => {
                        if (node === null) itemRefs.current.delete(item.approvalId);
                        else itemRefs.current.set(item.approvalId, node);
                      }}
                      type="button"
                      variant={selected ? 'secondary' : 'ghost'}
                      className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                      aria-pressed={selected}
                      data-approval-id={item.approvalId}
                      onClick={() => void slice.selectApproval(item.approvalId)}
                    >
                      <span className="min-w-0">
                        <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                          {categoryLabel(item.category)}
                        </span>
                        <span className="mt-1 block break-words text-sm text-[var(--color-text)]">
                          {item.summary}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {snapshot.nextCursor !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={snapshot.pageStatus === 'loading'}
              onClick={() => void slice.loadMore()}
            >
              {snapshot.pageStatus === 'loading' ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : null}
              Load more approvals
            </Button>
          ) : null}
        </div>

        <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          {selectedItem === undefined ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Select an approval to review its current request.
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  {categoryLabel(selectedItem.category)}
                </p>
                <h3 className="mt-1 break-words text-sm font-medium text-[var(--color-text)]">
                  {selectedItem.summary}
                </h3>
              </div>

              {selectedItem.previewRef === null ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  This request does not include a preview.
                </p>
              ) : null}

              {snapshot.previewStatus === 'loading' ? (
                <p
                  role="status"
                  className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"
                >
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  Loading preview…
                </p>
              ) : null}

              {snapshot.previewError !== null ? (
                <p role="alert" className="text-xs text-red-500">
                  {snapshot.previewError}
                </p>
              ) : null}

              {snapshot.preview !== null ? (
                snapshot.preview.isBinary ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Binary preview omitted ({snapshot.preview.byteLength} bytes).
                  </p>
                ) : (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-3 text-xs text-[var(--color-text)]">
                    {snapshot.preview.content}
                  </pre>
                )
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !decisionsEnabled || selectedIsPending || snapshot.pageStatus === 'loading'
                  }
                  aria-label={`Allow: ${selectedItem.summary}`}
                  onClick={() => void slice.allow()}
                >
                  {selectedIsPending && snapshot.pendingDecision?.decision === 'allow' ? (
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <Check aria-hidden="true" className="size-3.5" />
                  )}
                  Allow
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={
                    !decisionsEnabled || selectedIsPending || snapshot.pageStatus === 'loading'
                  }
                  aria-label={`Deny: ${selectedItem.summary}`}
                  onClick={() => void slice.deny()}
                >
                  {selectedIsPending && snapshot.pendingDecision?.decision === 'deny' ? (
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <X aria-hidden="true" className="size-3.5" />
                  )}
                  Deny
                </Button>
              </div>
              {!decisionsEnabled ? (
                <p role="status" className="text-xs text-[var(--color-text-muted)]">
                  Approval decisions are temporarily unavailable. You can still review requests.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true" className="mt-3 text-xs">
        {snapshot.decisionReceipt !== null ? (
          <p className="text-emerald-500">
            {snapshot.decisionReceipt.decision === 'allow' ? 'Allowed' : 'Denied'} and confirmed by
            the server.
          </p>
        ) : null}
        {snapshot.decisionError !== null ? (
          <p role="alert" className="text-red-500">
            {snapshot.decisionError}
          </p>
        ) : null}
      </div>
    </section>
  );
};
