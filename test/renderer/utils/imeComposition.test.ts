import { isImeComposing } from '@renderer/utils/imeComposition';
import { describe, expect, it } from 'vitest';

import type React from 'react';

function makeKeyEvent(opts: { isComposing?: boolean; keyCode?: number }): React.KeyboardEvent {
  return {
    nativeEvent: { isComposing: opts.isComposing ?? false } as KeyboardEvent,
    keyCode: opts.keyCode ?? 13,
  } as unknown as React.KeyboardEvent;
}

describe('isImeComposing', () => {
  it('is true while a composition is in progress (nativeEvent.isComposing)', () => {
    expect(isImeComposing(makeKeyEvent({ isComposing: true, keyCode: 13 }))).toBe(true);
  });

  it('is true for the composition-confirming keydown (keyCode 229 fallback)', () => {
    expect(isImeComposing(makeKeyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it('is false for a plain Enter press outside composition', () => {
    expect(isImeComposing(makeKeyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('is false for ordinary keys outside composition', () => {
    expect(isImeComposing(makeKeyEvent({ isComposing: false, keyCode: 65 }))).toBe(false);
  });
});
