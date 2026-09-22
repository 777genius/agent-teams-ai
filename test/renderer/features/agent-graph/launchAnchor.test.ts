import { describe, expect, it } from 'vitest';

import {
  HANDOFF_ANCHOR_LAYOUT,
  LAUNCH_ANCHOR_LAYOUT,
  getHandoffAnchorTarget,
  getLaunchAnchorBounds,
  getLaunchAnchorTarget,
  getLaunchAnchorScreenPlacement,
  getLaunchHudScale,
} from '../../../../packages/agent-graph/src/layout/launchAnchor';

describe('launchAnchor layout helpers', () => {
  it('clamps HUD scale to the supported zoom range', () => {
    expect(getLaunchHudScale(0.25)).toBeCloseTo(0.25);
    expect(getLaunchHudScale(0.92)).toBeCloseTo(0.92);
    expect(getLaunchHudScale(1.8)).toBe(LAUNCH_ANCHOR_LAYOUT.maxScale);
  });

  it('returns compact HUD bounds centered around the anchor', () => {
    const bounds = getLaunchAnchorBounds(240, 40);

    expect(bounds).toEqual({
      left: 72,
      top: -26,
      right: 408,
      bottom: 106,
    });
  });

  it('places the launch slot above and to the right of the lead', () => {
    const target = getLaunchAnchorTarget(100, 50);

    expect(target.x).toBeGreaterThan(100 + LAUNCH_ANCHOR_LAYOUT.compactWidth / 2 - 8);
    expect(target.y).toBeLessThan(50);
  });

  it('places handoff slots above-right for members and above-left for the lead', () => {
    const leadTarget = getHandoffAnchorTarget({ nodeX: 100, nodeY: 80, nodeKind: 'lead' });
    const memberTarget = getHandoffAnchorTarget({ nodeX: 100, nodeY: 80, nodeKind: 'member' });

    expect(leadTarget.x).toBeLessThan(100);
    expect(memberTarget.x).toBeGreaterThan(100);
    expect(leadTarget.y).toBeLessThan(80 - HANDOFF_ANCHOR_LAYOUT.reservedHeight / 4);
    expect(memberTarget.y).toBeLessThan(80 - HANDOFF_ANCHOR_LAYOUT.reservedHeight / 4);
  });

  it('clamps screen placement into the viewport while preserving visibility state', () => {
    const placement = getLaunchAnchorScreenPlacement({
      anchorX: 520,
      anchorY: -30,
      cameraX: 0,
      cameraY: 0,
      zoom: 1,
      viewportWidth: 480,
      viewportHeight: 320,
    });

    expect(placement.scale).toBe(1);
    expect(placement.x).toBeGreaterThanOrEqual(LAUNCH_ANCHOR_LAYOUT.viewportPadding);
    expect(placement.y).toBe(LAUNCH_ANCHOR_LAYOUT.viewportPadding);
    expect(placement.visible).toBe(true);
  });

  it('marks the anchor as not visible when it is well outside the viewport', () => {
    const placement = getLaunchAnchorScreenPlacement({
      anchorX: 1200,
      anchorY: 900,
      cameraX: 0,
      cameraY: 0,
      zoom: 1,
      viewportWidth: 480,
      viewportHeight: 320,
    });

    expect(placement.visible).toBe(false);
    expect(placement.x).toBeGreaterThanOrEqual(LAUNCH_ANCHOR_LAYOUT.viewportPadding);
    expect(placement.y).toBeGreaterThanOrEqual(LAUNCH_ANCHOR_LAYOUT.viewportPadding);
  });
});
