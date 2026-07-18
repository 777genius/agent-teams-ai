import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewActionHistoryPopover } from '../../../../../src/renderer/components/team/review/ReviewActionHistoryPopover';

import type { ReviewUndoAction } from '@shared/types';

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

describe('ReviewActionHistoryPopover', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
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
            diskTransitions: [{ filePath: '/repo/file.ts', kind: 'update' }],
          })}
          resolveFileLabel={() => 'src/file.ts'}
        />
      );
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-review-history-restore="action-1"]')
        ?.click()
    );
    const impact = document.querySelector('[data-review-history-impact]');
    expect(impact?.textContent).toContain('Actions in this jump');
    expect(impact?.textContent).toContain('Accept hunk');
    expect(impact?.textContent).toContain('1 net disk transition');
    expect(impact?.textContent).toContain('Update');
    expect(impact?.textContent).toContain('src/file.ts');
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
});
