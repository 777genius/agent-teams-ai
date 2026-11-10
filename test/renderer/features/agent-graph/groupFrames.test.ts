import { describe, expect, it } from 'vitest';

import {
  getGroupFrameLabelBounds,
  getGroupFrameLabelLayout,
  getGroupFrameLabelPlacement,
  getGroupFrameLabelScaleZoom,
  getGroupFrameLabelVerticalOffsetPx,
  getPaddedGroupFrameBounds,
  shouldRenderGroupFrameLabel,
  shouldRenderGroupFrameSemanticSummary,
  truncateGroupFrameLabel,
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
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 3 }), 0.02)).toBe(false);
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 1 }), 0.13)).toBe(false);
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 1 }), 0.14)).toBe(true);
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 3 }), 0.19)).toBe(false);
    expect(shouldRenderGroupFrameLabel(groupFrame({ depth: 3 }), 0.2)).toBe(true);
  });

  it('reserves a second overview line for aggregate counts', () => {
    const frame = groupFrame({ semanticSummary: '12 teams · 4 active · 18 tasks' });
    const singleLine = getGroupFrameLabelBounds(
      frame.label,
      { left: 0, top: 0, right: 1000, bottom: 800 },
      0.1
    );
    const aggregate = getGroupFrameLabelBounds(
      frame.label,
      { left: 0, top: 0, right: 1000, bottom: 800 },
      0.1,
      undefined,
      { secondaryLabel: frame.semanticSummary }
    );

    expect(aggregate.height).toBeGreaterThan(singleLine.height);
    expect(aggregate.secondaryTextY).toBeGreaterThan(aggregate.textY);
  });

  it('shows aggregate summaries only for overview-level frames', () => {
    const overview = groupFrame({ depth: 0, semanticSummary: '12 teams · 4 active · 18 tasks' });
    const nested = groupFrame({ depth: 1, semanticSummary: '4 teams · 2 active · 6 tasks' });

    expect(shouldRenderGroupFrameSemanticSummary(overview, 0.2)).toBe(true);
    expect(shouldRenderGroupFrameSemanticSummary(overview, 0.1)).toBe(false);
    expect(shouldRenderGroupFrameSemanticSummary(nested, 0.2)).toBe(true);
    expect(shouldRenderGroupFrameSemanticSummary(overview, 0.3)).toBe(false);
  });

  it('truncates long labels to the available frame width', () => {
    const measure = (value: string): number => value.length * 10;

    expect(truncateGroupFrameLabel('Государственные предприятия', 120, measure)).toBe(
      'Государстве…'
    );
    expect(truncateGroupFrameLabel('Коротко', 120, measure)).toBe('Коротко');
  });

  it('prepares the same truncated primary and summary labels for drawing and hit testing', () => {
    const frame = groupFrame({
      label: 'Очень длинное название организационной группы',
      semanticSummary: '120 команд · 42 активны · 918 задач',
      priority: 'primary',
    });
    const layout = getGroupFrameLabelLayout(
      frame,
      { left: 0, top: 100, right: 180, bottom: 400 },
      0.2,
      (value) => value.length * 10
    );

    expect(layout?.label.endsWith('…')).toBe(true);
    expect(layout?.secondaryLabel?.endsWith('…')).toBe(true);
    expect(layout?.bounds.width).toBeLessThanOrEqual(180);
  });

  it('uses compact padding for depth-aware organization frames', () => {
    const bounds = { left: -100, top: -50, right: 100, bottom: 50 };
    const padded = getPaddedGroupFrameBounds(bounds, 1, groupFrame({ depth: 0 }));

    expect(bounds.top - padded.top).toBe(44);
    expect(bounds.left - padded.left).toBe(22);
  });

  it('keeps a visible gutter between deeply nested frame borders', () => {
    const bounds = { left: -100, top: -50, right: 100, bottom: 50 };
    const depthTwo = getPaddedGroupFrameBounds(bounds, 1, groupFrame({ depth: 2, labelLane: 1 }));
    const depthThree = getPaddedGroupFrameBounds(bounds, 1, groupFrame({ depth: 3 }));

    expect(depthThree.left - depthTwo.left).toBe(7);
    expect(depthThree.top - depthTwo.top).toBe(11);
    expect(depthTwo.right - depthThree.right).toBe(7);
    expect(depthTwo.bottom - depthThree.bottom).toBe(28);
  });

  it('scales labels down with mini-map views to prevent cross-frame overlap', () => {
    expect(getGroupFrameLabelScaleZoom(0.01)).toBe(0.16);
    expect(getGroupFrameLabelScaleZoom(0.5)).toBe(0.5);
  });

  it('places group labels inside the frame instead of on the border', () => {
    const frame = groupFrame();
    const frameBounds = { left: 0, top: 100, right: 4000, bottom: 3000 };
    const labelBounds = getGroupFrameLabelBounds(frame.label, frameBounds, 0.02, undefined, {
      placement: getGroupFrameLabelPlacement(frame),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frame),
    });

    expect(labelBounds.top).toBeGreaterThan(frameBounds.top);
  });

  it('keeps organization labels outside the frame', () => {
    const frame = groupFrame({ priority: 'primary' });
    const frameBounds = { left: 0, top: 100, right: 4000, bottom: 3000 };
    const labelBounds = getGroupFrameLabelBounds(frame.label, frameBounds, 0.02, undefined, {
      placement: getGroupFrameLabelPlacement(frame),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frame),
    });

    expect(labelBounds.bottom).toBeLessThan(frameBounds.top);
  });

  it('places labels for nested groups near the bottom edge', () => {
    const frame = groupFrame({ depth: 1 });
    const frameBounds = { left: 0, top: 100, right: 4000, bottom: 3000 };
    const labelBounds = getGroupFrameLabelBounds(frame.label, frameBounds, 0.02, undefined, {
      placement: getGroupFrameLabelPlacement(frame),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(frame),
    });

    expect(labelBounds.bottom).toBeLessThan(frameBounds.bottom);
    expect(labelBounds.top).toBeGreaterThan(frameBounds.top);
  });

  it('stacks labels for nested levels instead of drawing them on top of each other', () => {
    const parent = groupFrame({ id: 'group:parent', depth: 1, labelLane: 1 });
    const child = groupFrame({ id: 'group:child', depth: 2 });
    const contentBounds = { left: 0, top: 100, right: 4000, bottom: 3000 };
    const parentBounds = getPaddedGroupFrameBounds(contentBounds, 0.5, parent);
    const childBounds = getPaddedGroupFrameBounds(contentBounds, 0.5, child);
    const parentLabelBounds = getGroupFrameLabelBounds(parent.label, parentBounds, 0.5, undefined, {
      placement: getGroupFrameLabelPlacement(parent),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(parent),
    });
    const childLabelBounds = getGroupFrameLabelBounds(child.label, childBounds, 0.5, undefined, {
      placement: getGroupFrameLabelPlacement(child),
      verticalOffsetPx: getGroupFrameLabelVerticalOffsetPx(child),
    });

    expect(childLabelBounds.bottom).toBeLessThan(parentLabelBounds.top);
    expect(getGroupFrameLabelVerticalOffsetPx(parent)).toBe(8);
    expect(getGroupFrameLabelVerticalOffsetPx(child)).toBe(8);
  });
});
