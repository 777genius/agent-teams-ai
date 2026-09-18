import { computeVerticalResizeHeight } from '@renderer/hooks/useResizablePanel';
import { describe, expect, it } from 'vitest';

describe('useResizablePanel vertical math', () => {
  it('grows a bottom-docked panel when the handle is dragged up', () => {
    expect(computeVerticalResizeHeight('bottom', 200, 400, 370, 120, 520)).toBe(230);
  });

  it('grows a top-docked panel when the handle is dragged down', () => {
    expect(computeVerticalResizeHeight('top', 200, 400, 430, 120, 520)).toBe(230);
  });

  it('clamps a bottom-docked panel to min and max height', () => {
    expect(computeVerticalResizeHeight('bottom', 200, 400, 700, 120, 520)).toBe(120);
    expect(computeVerticalResizeHeight('bottom', 200, 400, 0, 120, 520)).toBe(520);
  });
});
