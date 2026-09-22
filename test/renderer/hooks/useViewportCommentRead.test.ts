import { describe, expect, it, vi } from 'vitest';

import { getVisibleCommentIdsFallback } from '../../../src/renderer/hooks/useViewportCommentRead';

function makeRect({
  top,
  bottom,
  left = 0,
  right = 100,
}: {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('getVisibleCommentIdsFallback', () => {
  it('returns comment IDs that are visibly inside the scroll container', () => {
    const container = document.createElement('div');
    const visible = document.createElement('div');
    const hidden = document.createElement('div');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 100, bottom: 300 })
    );
    vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(makeRect({ top: 120, bottom: 180 }));
    vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(makeRect({ top: 320, bottom: 380 }));

    const result = getVisibleCommentIdsFallback(
      container,
      new Map([
        ['visible-comment', visible],
        ['hidden-comment', hidden],
      ])
    );

    expect(result).toEqual(['visible-comment']);
  });

  it('requires at least 10% of the comment height to be visible', () => {
    const container = document.createElement('div');
    const barelyVisible = document.createElement('div');
    const enoughVisible = document.createElement('div');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 100, bottom: 300 })
    );
    vi.spyOn(barelyVisible, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 295, bottom: 405 })
    );
    vi.spyOn(enoughVisible, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 290, bottom: 390 })
    );

    const result = getVisibleCommentIdsFallback(
      container,
      new Map([
        ['barely-visible', barelyVisible],
        ['enough-visible', enoughVisible],
      ])
    );

    expect(result).toEqual(['enough-visible']);
  });
});
