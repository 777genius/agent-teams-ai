import { describe, expect, it } from 'vitest';

import {
  getGroupFrameLabelBounds,
  getGroupFrameLabelScaleZoom,
  getGroupFrameLabelVerticalOffsetPx,
  shouldRenderGroupFrameLabel,
} from '../../../../packages/agent-graph/src/canvas/group-frames';

import type { GraphGroupFrame } from '@claude-teams/agent-graph';

function groupFrame(overrides: Partial<GraphGroupFrame> = {}): GraphGroupFrame {
  return {
    id: 'group:platform',
    label: 'Platform Group',
    nodeIds: ['team:platform'],
    priority: 'normal',
    ...overrides,
  };
}

describe('group frame labels', () => {
  it('keeps normal group labels visible while zoomed out', () => {
    expect(shouldRenderGroupFrameLabel(groupFrame(), 0.02)).toBe(true);
    expect(shouldRenderGroupFrameLabel(groupFrame(), 0.06)).toBe(true);
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 3 }), 0.02)).toBe(true);
  });

  it('keeps labels readable at far zoom', () => {
    expect(getGroupFrameLabelScaleZoom(0.01)).toBe(0.015);
  });

  it('places group labels inside the frame instead of on the border', () => {
    const frame = groupFrame();
    const frameBounds = { left: 0, top: 100, right: 400, bottom: 300 };
    const labelBounds = getGroupFrameLabelBounds(frame.label, frameBounds, 0.02, undefined, {
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frame),
    });

    expect(labelBounds.top).toBeGreaterThan(frameBounds.top);
  });
});
