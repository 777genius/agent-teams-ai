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
});
