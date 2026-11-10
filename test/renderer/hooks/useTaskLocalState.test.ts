import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_KEY = '/workspace/demo';
const PINNED_PROJECT_STORAGE_KEY = 'taskPinnedProjectKeys';

function Probe(): React.JSX.Element {
  const state = useTaskLocalState();
  return React.createElement(
    'div',
    null,
    React.createElement('span', {
      'data-testid': 'pinned',
      'data-pinned': state.isProjectPinned(PROJECT_KEY) ? 'true' : 'false',
    }),
    React.createElement(
      'button',
      { type: 'button', onClick: () => state.toggleProjectPin(PROJECT_KEY) },
      'toggle'
    )
  );
}

describe('useTaskLocalState project pins', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('toggles a project pin and persists it across remounts', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="pinned"]')?.getAttribute('data-pinned')).toBe('false');

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="pinned"]')?.getAttribute('data-pinned')).toBe('true');
    expect(JSON.parse(localStorage.getItem(PINNED_PROJECT_STORAGE_KEY) ?? '[]')).toEqual([
      PROJECT_KEY,
    ]);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    const remountHost = document.createElement('div');
    document.body.appendChild(remountHost);
    const remountRoot = createRoot(remountHost);

    await act(async () => {
      remountRoot.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(remountHost.querySelector('[data-testid="pinned"]')?.getAttribute('data-pinned')).toBe(
      'true'
    );

    await act(async () => {
      remountHost.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(remountHost.querySelector('[data-testid="pinned"]')?.getAttribute('data-pinned')).toBe(
      'false'
    );
    expect(JSON.parse(localStorage.getItem(PINNED_PROJECT_STORAGE_KEY) ?? '[]')).toEqual([]);

    await act(async () => {
      remountRoot.unmount();
      await Promise.resolve();
    });
  });
});
