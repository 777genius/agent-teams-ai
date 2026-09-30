import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  commandPaletteOpen: false,
  openCommandPalette: vi.fn(),
}));
const overlay = vi.hoisted(() => ({ count: 0 }));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));
vi.mock('@renderer/hooks/useOverlayOccupancy', () => ({
  getOverlaySnapshot: () => ({ count: overlay.count, generation: 0 }),
}));

import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';

function Shell(): null {
  useKeyboardShortcuts();
  return null;
}

describe('shell Cmd/Ctrl+K', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    state.commandPaletteOpen = false;
    state.openCommandPalette.mockReset();
    overlay.count = 0;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens once from a focused editable field and yields to IME or an occupied overlay', () => {
    const host = document.createElement('div');
    const input = document.createElement('input');
    host.appendChild(input);
    document.body.appendChild(host);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const root = createRoot(mount);
    act(() => root.render(<Shell />));
    input.focus();

    const press = (options: KeyboardEventInit = {}): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true,
        ...options,
      });
      act(() => input.dispatchEvent(event));
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(state.openCommandPalette).toHaveBeenCalledOnce();

    press({ isComposing: true });
    overlay.count = 1;
    press();
    overlay.count = 0;
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('data-state', 'open');
    document.body.appendChild(modal);
    press();
    modal.remove();
    state.commandPaletteOpen = true;
    act(() => root.render(<Shell />));
    press();
    expect(state.openCommandPalette).toHaveBeenCalledOnce();

    state.commandPaletteOpen = false;
    act(() => root.render(<Shell />));
    vi.mocked(document.hasFocus).mockReturnValue(false);
    press();
    expect(state.openCommandPalette).toHaveBeenCalledOnce();

    act(() => root.unmount());
    press();
    expect(state.openCommandPalette).toHaveBeenCalledOnce();
  });
});
