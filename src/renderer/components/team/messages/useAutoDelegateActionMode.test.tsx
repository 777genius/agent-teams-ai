import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAutoDelegateActionMode } from './useAutoDelegateActionMode';

import type { AgentActionMode } from '@shared/types';

const Harness = ({
  addressKey,
  setActionMode,
}: {
  addressKey: string;
  setActionMode: (mode: AgentActionMode) => void;
}): null => {
  useAutoDelegateActionMode({
    addressKey,
    isLoaded: true,
    canDelegate: true,
    shouldAutoDelegate: true,
    actionMode: 'do',
    setActionMode,
  });
  return null;
};

describe('useAutoDelegateActionMode', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('initializes delegate separately for each restored draft address', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const setActionMode = vi.fn();

    act(() => root.render(<Harness addressKey="direct:alice" setActionMode={setActionMode} />));
    expect(setActionMode).toHaveBeenCalledExactlyOnceWith('delegate');

    setActionMode.mockClear();
    act(() => root.render(<Harness addressKey="direct:bob" setActionMode={setActionMode} />));
    expect(setActionMode).toHaveBeenCalledExactlyOnceWith('delegate');

    act(() => root.unmount());
  });
});
