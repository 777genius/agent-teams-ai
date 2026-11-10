import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReviewActionHistoryPopover,
  type ReviewHistoryRestorePreview,
} from '../../../../../src/renderer/components/team/review/ReviewActionHistoryPopover';

import type { ReviewUndoAction } from '@shared/types';

const popoverMock = vi.hoisted(() => ({
  current: null as null | { open: boolean; onOpenChange: (open: boolean) => void },
}));

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    popoverMock.current = { open, onOpenChange };
    return <>{children}</>;
  },
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <span onClick={() => popoverMock.current?.onOpenChange(true)}>{children}</span>
  ),
}));

function makeAction(index: number): ReviewUndoAction {
  return {
    id: `action-${index}`,
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    kind: 'hunk',
    descriptor: {
      intent: 'accept-hunk',
      filePath: '/repo/file.ts',
      hunkIndex: index,
    },
    action: { filePath: '/repo/file.ts', originalIndex: index },
  };
}

function openHistory(container: HTMLElement): void {
  act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Review history:"]')?.click()
  );
}

describe('ReviewActionHistoryPopover', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    popoverMock.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('ignores a stale reopen after Undo moves the history position', () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    act(() => {
      root.render(<ReviewActionHistoryPopover undoHistory={[older, current]} redoHistory={[]} />);
    });

    const staleOpen = popoverMock.current?.onOpenChange;
    openHistory(container);
    expect(popoverMock.current?.open).toBe(true);

    act(() => {
      root.render(<ReviewActionHistoryPopover undoHistory={[older, current]} redoHistory={[]} />);
    });
    expect(popoverMock.current?.open).toBe(true);

    act(() => {
      root.render(<ReviewActionHistoryPopover undoHistory={[older]} redoHistory={[]} />);
    });
    expect(popoverMock.current?.open).toBe(false);

    act(() => staleOpen?.(true));
    expect(popoverMock.current?.open).toBe(false);
    act(() => root.unmount());
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('progressively reveals every retained undo action beyond the initial preview', () => {
    const root = createRoot(container);
    const undoHistory = Array.from({ length: 80 }, (_, index) => makeAction(index));
    act(() => {
      root.render(<ReviewActionHistoryPopover undoHistory={undoHistory} redoHistory={[]} />);
    });
    openHistory(container);

    expect(container.querySelectorAll('[data-review-history-action]')).toHaveLength(12);
    const firstReveal = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show 50 older undo actions"]'
    );
    expect(firstReveal).not.toBeNull();
    act(() => firstReveal?.click());

    expect(container.querySelectorAll('[data-review-history-action]')).toHaveLength(62);
    const finalReveal = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show 18 older undo actions"]'
    );
    expect(finalReveal).not.toBeNull();
    act(() => finalReveal?.click());

    expect(container.querySelectorAll('[data-review-history-action]')).toHaveLength(80);
    expect(container.querySelector('button[aria-label*="older undo"]')).toBeNull();
    act(() => root.unmount());
  });

  it('navigates from a file-scoped history row', () => {
    const root = createRoot(container);
    const onNavigateToAction = vi.fn();
    const action = makeAction(3);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[action]}
          redoHistory={[]}
          onNavigateToAction={onNavigateToAction}
        />
      );
    });
    openHistory(container);

    const actionButton = container.querySelector<HTMLButtonElement>(
      '[data-review-history-action="action-3"]'
    );
    expect(actionButton?.disabled).toBe(false);
    act(() => actionButton?.click());
    expect(onNavigateToAction).toHaveBeenCalledWith(action);
    act(() => root.unmount());
  });

  it('confirms restoring an older checkpoint without conflating it with navigation', async () => {
    const root = createRoot(container);
    const onNavigateToAction = vi.fn();
    const onRestoreToTarget = vi.fn().mockResolvedValue(undefined);
    const older = makeAction(1);
    const current = makeAction(2);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onNavigateToAction={onNavigateToAction}
          onRestoreToTarget={onRestoreToTarget}
        />
      );
    });
    openHistory(container);

    const currentRestore = container.querySelector<HTMLButtonElement>(
      '[data-review-history-restore="action-2"]'
    );
    const olderRestore = container.querySelector<HTMLButtonElement>(
      '[data-review-history-restore="action-1"]'
    );
    expect(currentRestore?.disabled).toBe(true);
    expect(olderRestore?.disabled).toBe(false);
    act(() => olderRestore?.click());
    expect(onNavigateToAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('undo 1 review action');

    const dialog = document.querySelector('[role="alertdialog"]');
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Restore'
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(onRestoreToTarget).toHaveBeenCalledWith({
      kind: 'after-action',
      stack: 'undo',
      actionId: older.id,
    });
    act(() => root.unmount());
  });

  it('keeps a bulk checkpoint restorable even though it has no navigation target', () => {
    const root = createRoot(container);
    const bulk: ReviewUndoAction = {
      id: 'bulk-action',
      createdAt: '2026-07-18T08:00:00.000Z',
      kind: 'bulk',
      descriptor: { intent: 'accept-all', fileCount: 2 },
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      diskSnapshots: [],
    };
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[bulk, makeAction(4)]}
          redoHistory={[]}
          onNavigateToAction={vi.fn()}
          onRestoreToTarget={vi.fn().mockResolvedValue(undefined)}
        />
      );
    });
    openHistory(container);

    expect(container.querySelector('button[data-review-history-action="bulk-action"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-review-history-restore="bulk-action"]')
        ?.disabled
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>('[data-review-history-restore="start"]')?.disabled
    ).toBe(false);
    act(() => root.unmount());
  });

  it('shows the exact actions and net disk impact before confirmation', () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onRestoreToTarget={vi.fn().mockResolvedValue(undefined)}
          getRestorePreview={() => ({
            direction: 'undo',
            actions: [current],
            diskTransitions: [
              {
                filePath: '/repo/file.ts',
                kind: 'update',
                lineStatsStatus: 'exact',
                linesAdded: 3,
                linesRemoved: 2,
              },
              {
                filePath: '/repo/renamed.ts',
                kind: 'rename',
                lineStatsStatus: 'unavailable-rename',
              },
              {
                filePath: '/repo/large.ts',
                kind: 'update',
                lineStatsStatus: 'omitted-large-update',
              },
            ],
          })}
          resolveFileLabel={() => 'src/file.ts'}
        />
      );
    });
    openHistory(container);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );
    const impact = document.querySelector('[data-review-history-impact]');
    expect(impact?.textContent).toContain('Actions in this jump');
    expect(impact?.textContent).toContain('Accept hunk');
    expect(impact?.textContent).toContain('3 net disk transitions');
    expect(impact?.textContent).toContain('Update');
    expect(impact?.textContent).toContain('src/file.ts');
    expect(impact?.textContent).toContain('+3');
    expect(impact?.textContent).toContain('-2');
    expect(impact?.textContent).toContain('Counts unavailable');
    expect(impact?.textContent).toContain('Large diff');
    expect(impact?.textContent).not.toContain('+0');
    expect(impact?.textContent).not.toContain('-0');
    act(() => root.unmount());
  });

  it('fails closed when an exact Restore impact cannot be prepared', () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onRestoreToTarget={vi.fn().mockResolvedValue(undefined)}
          getRestorePreview={() => {
            throw new Error('Rename ranges must be restored one action at a time.');
          }}
        />
      );
    });
    openHistory(container);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Rename ranges must be restored one action at a time.');
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Restore'
    );
    expect(confirm?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('refreshes a stale impact and requires confirmation again before Restore', async () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    const added = makeAction(3);
    const onRestoreToTarget = vi.fn().mockResolvedValue(undefined);
    let preview: ReviewHistoryRestorePreview = {
      direction: 'undo',
      actions: [current],
      diskTransitions: [
        {
          filePath: '/repo/file.ts',
          kind: 'update',
          lineStatsStatus: 'exact',
          linesAdded: 1,
          linesRemoved: 1,
        },
      ],
    };
    const getRestorePreview = vi.fn(() => preview);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onRestoreToTarget={onRestoreToTarget}
          getRestorePreview={getRestorePreview}
        />
      );
    });
    openHistory(container);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );
    preview = {
      direction: 'undo',
      actions: [current, added],
      diskTransitions: [
        {
          filePath: '/repo/new.ts',
          kind: 'create',
          lineStatsStatus: 'exact',
          linesAdded: 4,
          linesRemoved: 0,
        },
      ],
    };

    const findConfirm = () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Restore' || button.textContent === 'Retry restore'
      );
    await act(async () => {
      findConfirm()?.click();
      await Promise.resolve();
    });
    expect(onRestoreToTarget).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Review history changed.');
    expect(document.body.textContent).toContain('undo 2 review actions');
    expect(document.body.textContent).toContain('/repo/new.ts');
    expect(document.body.textContent).toContain('+4');

    await act(async () => {
      findConfirm()?.click();
      await Promise.resolve();
    });
    expect(onRestoreToTarget).toHaveBeenCalledTimes(1);
    expect(getRestorePreview).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
  });

  it('uses explicit recovery after Restore execution fails', async () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    const onRestoreToTarget = vi.fn().mockRejectedValue(new Error('partial restore interrupted'));
    const onRecoverFailedRestore = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onRestoreToTarget={onRestoreToTarget}
          onRecoverFailedRestore={onRecoverFailedRestore}
        />
      );
    });
    openHistory(container);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );

    const findConfirm = (label: string) =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === label
      );
    await act(async () => {
      findConfirm('Restore')?.click();
      await Promise.resolve();
    });
    expect(onRestoreToTarget).toHaveBeenCalledTimes(1);
    expect(onRecoverFailedRestore).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('partial restore interrupted');
    expect(findConfirm('Recover restore')).toBeDefined();

    await act(async () => {
      findConfirm('Recover restore')?.click();
      await Promise.resolve();
    });
    expect(onRestoreToTarget).toHaveBeenCalledTimes(1);
    expect(onRecoverFailedRestore).toHaveBeenCalledWith({
      kind: 'after-action',
      stack: 'undo',
      actionId: older.id,
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    act(() => root.unmount());
  });

  it('coalesces duplicate confirmation events while Restore is running', async () => {
    const root = createRoot(container);
    const older = makeAction(1);
    const current = makeAction(2);
    let finishRestore: (() => void) | undefined;
    const pendingRestore = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const onRestoreToTarget = vi.fn(() => pendingRestore);
    act(() => {
      root.render(
        <ReviewActionHistoryPopover
          undoHistory={[older, current]}
          redoHistory={[]}
          onRestoreToTarget={onRestoreToTarget}
        />
      );
    });
    openHistory(container);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );
    const confirm = [
      ...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent === 'Restore');
    act(() => {
      confirm?.click();
      confirm?.click();
    });
    expect(onRestoreToTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRestore?.();
      await pendingRestore;
    });
    act(() => root.unmount());
  });
});
