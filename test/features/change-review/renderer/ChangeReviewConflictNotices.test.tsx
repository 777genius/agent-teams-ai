import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
} from '@features/change-review/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewConflictCandidateSelection } from '@features/change-review/renderer';

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  AlertDialogCancel: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const candidate: ReviewConflictCandidateSelection = {
  kind: 'decision',
  value: {
    id: 'decision-a',
    capturedAt: '2026-07-23T12:00:00.000Z',
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    expectedRevision: 1,
    observedCurrentRevision: 2,
    hunkDecisionCount: 0,
    fileDecisionCount: 0,
    undoDepth: 2,
    redoDepth: 1,
  },
};

describe('ChangeReviewConflictNotices', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('routes retry, discard and recover interactions through callbacks', () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const onRequestDiscard = vi.fn();
    const onRecover = vi.fn(() => Promise.resolve());
    const render = (loadError: string | null): void => {
      act(() => {
        root.render(
          <ChangeReviewConflictNotices
            loadError={loadError}
            refreshPending={false}
            activeCandidate={candidate}
            activeCandidateRecoverable
            candidateCount={2}
            resolvingCandidateId={null}
            onRetry={onRetry}
            onRequestDiscard={onRequestDiscard}
            onRecover={onRecover}
          />
        );
      });
    };
    render('load failed');

    const button = (label: string) =>
      [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
    act(() => button('Retry recovery check').click());
    render(null);
    act(() => button('Discard recovery branch').click());
    act(() => button('Switch to recovery').click());

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRequestDiscard).toHaveBeenCalledWith(candidate);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('1 more recovery copy is queued.');
  });

  it('routes discard confirmation without owning persistence or store behavior', () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <ChangeReviewConflictDiscardDialog
          pendingDiscard={candidate}
          resolvingCandidateId={null}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      );
    });

    const confirm = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Discard recovery branch'
    );
    act(() => confirm?.click());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Your current branch stays saved.');
  });
});
