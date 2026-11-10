import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedReviewStateRecoveryGate } from '../../../../../src/renderer/components/team/review/SavedReviewStateRecoveryGate';

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label
  );
}

describe('SavedReviewStateRecoveryGate', () => {
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

  it('requires confirmation and names every recovery category that will be deleted', () => {
    const root = createRoot(container);
    const onDiscard = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <SavedReviewStateRecoveryGate
          decisionStateUnreadable
          draftHistoryUnreadable
          busy={false}
          onRetry={vi.fn()}
          onDiscard={onDiscard}
        />
      );
    });

    act(() => findButton('Discard saved state')?.click());

    const confirmation = document.querySelector('[data-review-saved-state-discard-confirmation]');
    expect(confirmation?.textContent).toContain('Accept/Reject and Undo/Redo history');
    expect(confirmation?.textContent).toContain('manual edits and editor Undo history');
    expect(confirmation?.textContent).toContain('Project files will not be changed');
    expect(confirmation?.textContent).toContain('This cannot be undone');
    expect(onDiscard).not.toHaveBeenCalled();

    act(() => findButton('Keep saved state')?.click());
    expect(document.querySelector('[data-review-saved-state-discard-confirmation]')).toBeNull();
    expect(onDiscard).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps a failed discard recoverable and closes only after a successful retry', async () => {
    const root = createRoot(container);
    const onDiscard = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Recovery data is still in use'))
      .mockResolvedValueOnce(undefined);
    act(() => {
      root.render(
        <SavedReviewStateRecoveryGate
          decisionStateUnreadable
          draftHistoryUnreadable={false}
          busy={false}
          onRetry={vi.fn()}
          onDiscard={onDiscard}
        />
      );
    });

    act(() => findButton('Discard saved state')?.click());
    await act(async () => {
      findButton('Discard forever')?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Recovery data is still in use');
    expect(findButton('Retry discard')).toBeDefined();
    expect(onDiscard).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton('Retry discard')?.click();
      await Promise.resolve();
    });

    expect(onDiscard).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-review-saved-state-discard-confirmation]')).toBeNull();
    act(() => root.unmount());
  });
});
