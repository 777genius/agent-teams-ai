import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { confirm, ConfirmDialog } from '@renderer/components/common/ConfirmDialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('ConfirmDialog modes', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<ConfirmDialog />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps two actions in the default confirm mode', async () => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = confirm({ title: 'Delete?', message: 'Confirm deletion' });
    });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('button')).toHaveLength(2);
    expect(dialog.querySelector('[data-confirm-btn]')).toBe(document.activeElement);
    await act(async () =>
      (dialog.querySelector('[data-confirm-btn]') as HTMLButtonElement).click()
    );
    await expect(result).resolves.toBe(true);
  });

  it('shows one focused Close action in info mode', async () => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = confirm({
        mode: 'info',
        title: 'Stopped?',
        message: 'Unknown',
        confirmLabel: 'Close',
      });
    });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('button')).toHaveLength(1);
    const closeButton = dialog.querySelector('[data-confirm-btn]') as HTMLButtonElement;
    expect(closeButton).toBe(document.activeElement);
    expect(closeButton.textContent).toBe('Close');
    await act(async () => closeButton.click());
    await expect(result).resolves.toBe(true);
  });

  it.each(['Escape', 'backdrop'] as const)('cleans the singleton after info %s', async (method) => {
    let first!: Promise<boolean>;
    await act(async () => {
      first = confirm({
        mode: 'info',
        title: 'Unknown',
        message: 'Unknown',
        confirmLabel: 'Close',
      });
    });
    await act(async () => {
      if (method === 'Escape')
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else (host.firstElementChild?.firstElementChild as HTMLButtonElement).click();
    });
    await expect(first).resolves.toBe(false);

    let second!: Promise<boolean>;
    await act(async () => {
      second = confirm({ mode: 'info', title: 'Again', message: 'Again', confirmLabel: 'Close' });
    });
    await act(async () => (host.querySelector('[data-confirm-btn]') as HTMLButtonElement).click());
    await expect(second).resolves.toBe(true);
  });
});
