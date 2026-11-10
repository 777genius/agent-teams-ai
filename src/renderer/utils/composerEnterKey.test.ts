import { describe, expect, it, vi } from 'vitest';

import { handleComposerEnterKey } from './composerEnterKey';

import type React from 'react';

function event(overrides: Partial<React.KeyboardEvent<HTMLTextAreaElement>> = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe('composer Enter actions', () => {
  it('sends on ordinary Enter and preserves Shift+Enter newline', () => {
    const send = vi.fn();
    const queue = vi.fn();
    const enter = event();
    expect(handleComposerEnterKey(enter, send, queue, true)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
    const newline = event({ shiftKey: true, metaKey: true });
    expect(handleComposerEnterKey(newline, send, queue, true)).toBe(false);
    expect(newline.preventDefault).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { isMac: true, modifier: { metaKey: true } },
    { isMac: false, modifier: { ctrlKey: true } },
  ])(
    'queues exactly once on the platform modifier, including blocked enqueue',
    ({ isMac, modifier }) => {
      const send = vi.fn();
      // Queue eligibility belongs to the callback; a no-op must never fall through to send.
      const queue = vi.fn();
      const key = event(modifier);
      expect(handleComposerEnterKey(key, send, queue, isMac)).toBe(true);
      expect(key.preventDefault).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(handleComposerEnterKey(event({ ...modifier, repeat: true }), send, queue, isMac)).toBe(
        true
      );
      expect(queue).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('keeps existing modified Enter send behavior without queue configuration', () => {
    const send = vi.fn();
    expect(handleComposerEnterKey(event({ metaKey: true }), send, undefined, true)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    handleComposerEnterKey(event({ repeat: true }), send, undefined, true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { defaultPrevented: true },
    { nativeEvent: { isComposing: true } as KeyboardEvent },
    { keyCode: 229 },
  ])('does not act on consumed mention or IME confirmation', (overrides) => {
    const send = vi.fn();
    const queue = vi.fn();
    const key = event({ metaKey: true, ...overrides });
    expect(handleComposerEnterKey(key, send, queue, true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(key.preventDefault).not.toHaveBeenCalled();
  });
});
